import type { Analysis } from "./analyze";

/**
 * Independent verification of the model's answer (SC-007: the run is only a success when the
 * answer is *about the decrypted data*). Layers, all computed here without the model:
 *  1. every citation must be non-empty and appear verbatim in the dataset;
 *  2. for a deterministic question ("which <label> has the highest <value>?") the harness
 *     tabulates the dataset itself (strict RFC 4180 CSV or the seed JSON table, exact decimal
 *     comparison), computes the winning row, and requires the model's structured `result` to
 *     equal that row exactly, one citation whose label IS that row's label and whose value IS
 *     that row's value, and the answer text to open with the verified conclusion
 *     `<label>: <value>` so a denial cannot hide behind the right words.
 * The verdict carries the harness-generated `statement`; consumers should quote that, not the
 * free text. A run whose answer fails any layer is a failure - no answer.json, non-zero exit.
 */
export type ExtremeCheck = {
  labelColumn: string;
  valueColumn: string;
  op: "max" | "min";
};

/** The seeded demo dataset A (apps/contracts/scripts/seed-data): visitors per district. */
export const DEFAULT_CHECK: ExtremeCheck = {
  labelColumn: "district",
  valueColumn: "visitors",
  op: "max",
};

export function questionFor(check: ExtremeCheck): string {
  const superlative = check.op === "max" ? "highest" : "lowest";
  return `Which ${check.labelColumn} has the ${superlative} ${check.valueColumn} in a single row of the dataset, and what is that ${check.valueColumn} value? Put the winning ${check.labelColumn} and its exact ${check.valueColumn} in \`result\`; in \`evidence\` cite that row with label = the ${check.labelColumn} exactly as written and value = the ${check.valueColumn} exactly as written; and begin \`answer\` with "<${check.labelColumn}>: <${check.valueColumn}>" before any explanation.`;
}

export function parseCheck(raw: string | undefined): ExtremeCheck {
  if (raw === undefined || raw === "") return DEFAULT_CHECK;
  const parsed = JSON.parse(raw) as Partial<ExtremeCheck>;
  if (
    typeof parsed.labelColumn !== "string" ||
    typeof parsed.valueColumn !== "string" ||
    (parsed.op !== "max" && parsed.op !== "min")
  ) {
    throw new Error(
      "AGENT_CHECK must be {labelColumn, valueColumn, op: max|min}",
    );
  }
  return {
    labelColumn: parsed.labelColumn,
    valueColumn: parsed.valueColumn,
    op: parsed.op,
  };
}

export type Table = { columns: string[]; rows: string[][] };

/**
 * Strict RFC 4180 parser over the whole stream: quoted fields may contain commas, doubled
 * quotes and line breaks; a quote inside an unquoted field, or text after a closing quote, is
 * an error (never silently normalised).
 */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let wasQuoted = false;
  let i = 0;
  const endField = (): void => {
    record.push(field);
    field = "";
    wasQuoted = false;
  };
  const endRecord = (): void => {
    endField();
    records.push(record);
    record = [];
  };
  while (i < text.length) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 2;
      } else if (ch === '"') {
        quoted = false;
        wasQuoted = true;
        i += 1;
      } else {
        field += ch;
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      if (field !== "" || wasQuoted)
        throw new Error(`csv: misplaced quote at offset ${i}`);
      quoted = true;
      i += 1;
    } else if (ch === ",") {
      endField();
      i += 1;
    } else if (ch === "\r" && text[i + 1] === "\n") {
      endRecord();
      i += 2;
    } else if (ch === "\n") {
      endRecord();
      i += 1;
    } else {
      if (wasQuoted)
        throw new Error(`csv: text after closing quote at offset ${i}`);
      field += ch;
      i += 1;
    }
  }
  if (quoted) throw new Error("csv: unterminated quote");
  if (field !== "" || wasQuoted || record.length > 0) endRecord();
  return records.filter((r) => !(r.length === 1 && r[0] === ""));
}

/** `{columns, rows}` JSON (the seed format) or a CSV with a header row; ragged rows are errors. */
export function parseTable(format: string, content: string): Table {
  let columns: string[];
  let rows: string[][];
  if (format === "json") {
    const parsed = JSON.parse(content) as { columns?: unknown; rows?: unknown };
    if (!Array.isArray(parsed.columns) || !Array.isArray(parsed.rows)) {
      throw new Error("json dataset has no columns/rows table");
    }
    columns = parsed.columns.map(String);
    rows = parsed.rows.map((r, i) => {
      if (!Array.isArray(r))
        throw new Error(`json dataset: row ${i} is not an array`);
      return r.map((c) => (c === null || c === undefined ? "" : String(c)));
    });
  } else if (format === "csv") {
    const [header, ...body] = parseCsv(content);
    if (header === undefined) throw new Error("csv dataset is empty");
    columns = header.map((c) => c.trim());
    rows = body.map((r) => r.map((c) => c.trim()));
  } else {
    throw new Error(`cannot tabulate a ${format} dataset`);
  }
  rows.forEach((row, i) => {
    if (row.length !== columns.length) {
      throw new Error(
        `dataset row ${i} has ${row.length} cells, header has ${columns.length}`,
      );
    }
  });
  return { columns, rows };
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/** Exact comparison of plain decimal strings (no float rounding, any magnitude). */
export function compareDecimal(a: string, b: string): number {
  const pa = DECIMAL.exec(a);
  const pb = DECIMAL.exec(b);
  if (pa === null || pb === null)
    throw new Error(
      `not a plain decimal: ${JSON.stringify(pa === null ? a : b)}`,
    );
  const scale = Math.max(pa[3]?.length ?? 0, pb[3]?.length ?? 0);
  const toScaled = (m: RegExpExecArray): bigint => {
    const frac = (m[3] ?? "").padEnd(scale, "0");
    const magnitude = BigInt(`${m[2]}${frac}`);
    return m[1] === "-" ? -magnitude : magnitude;
  };
  const x = toScaled(pa);
  const y = toScaled(pb);
  return x < y ? -1 : x > y ? 1 : 0;
}

export type Expected = { label: string; value: string };

/** The winning row; every candidate row must have a non-empty label and a plain decimal value. */
export function expectedExtreme(table: Table, check: ExtremeCheck): Expected {
  const labelAt = table.columns.indexOf(check.labelColumn);
  const valueAt = table.columns.indexOf(check.valueColumn);
  if (labelAt === -1 || valueAt === -1) {
    throw new Error(
      `dataset has no ${check.labelColumn} / ${check.valueColumn} columns`,
    );
  }
  let best: Expected | undefined;
  table.rows.forEach((row, i) => {
    const value = row[valueAt] ?? "";
    const label = row[labelAt] ?? "";
    if (!DECIMAL.test(value)) {
      throw new Error(
        `dataset row ${i}: ${check.valueColumn} ${JSON.stringify(value)} is not a plain decimal`,
      );
    }
    if (label === "")
      throw new Error(`dataset row ${i}: empty ${check.labelColumn}`);
    const cmp = best === undefined ? 1 : compareDecimal(value, best.value);
    if (best === undefined || (check.op === "max" ? cmp > 0 : cmp < 0))
      best = { label, value };
  });
  if (best === undefined) throw new Error("dataset has no rows");
  return best;
}

export type Verdict = {
  ok: boolean;
  problems: string[];
  expected?: Expected;
  /** the harness-generated conclusion (what a consumer should quote, not the free text) */
  statement?: string;
};

function statementFor(check: ExtremeCheck, expected: Expected): string {
  return `${expected.label}: ${expected.value} (${check.op === "max" ? "highest" : "lowest"} ${check.valueColumn} per ${check.labelColumn})`;
}

function citationProblems(analysis: Analysis, dataset: string): string[] {
  const problems: string[] = [];
  if (analysis.evidence.length === 0) problems.push("no evidence cited");
  for (const e of analysis.evidence) {
    if (e.value.trim() === "" || e.label.trim() === "") {
      problems.push("empty citation");
      continue;
    }
    if (!dataset.includes(e.value))
      problems.push(`evidence "${e.value}" not in the dataset`);
  }
  return problems;
}

/**
 * The gate `runAgent` applies before it reports success. With a `check`: the model's structured
 * `result` must equal the computed row, a citation must carry exactly that row's label and
 * value, and the answer must open with `<label>: <value>`; without one, citations alone decide.
 */
export function verifyAnalysis(
  analysis: Analysis,
  dataset: { format: string; content: string },
  check: ExtremeCheck | undefined,
): Verdict {
  const problems = citationProblems(analysis, dataset.content);
  if (check === undefined) return { ok: problems.length === 0, problems };
  const expected = expectedExtreme(
    parseTable(dataset.format, dataset.content),
    check,
  );
  const result = analysis.result;
  if (result === undefined) {
    problems.push("no structured result");
  } else if (
    result.label !== expected.label ||
    result.value !== expected.value
  ) {
    problems.push(
      `result ${result.label}=${result.value} is not the ${check.op} row ${expected.label}=${expected.value}`,
    );
  }
  const bound = analysis.evidence.some(
    (e) => e.value === expected.value && e.label === expected.label,
  );
  if (!bound)
    problems.push(
      `no citation with label ${expected.label} and value ${expected.value}`,
    );
  const opening = `${expected.label}: ${expected.value}`;
  if (!analysis.answer.trimStart().startsWith(opening)) {
    problems.push(`answer does not open with "${opening}"`);
  }
  return {
    ok: problems.length === 0,
    problems,
    expected,
    statement: statementFor(check, expected),
  };
}
