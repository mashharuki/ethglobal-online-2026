import type { Analysis } from "./analyze";

/**
 * Independent verification of the model's answer (SC-007: the run is only a success when the
 * answer is *about the decrypted data*). Layers, all computed here without the model:
 *  1. every citation must be non-empty and appear verbatim in the dataset;
 *  2. for a deterministic question ("which <label> has the highest <value>?") the harness
 *     tabulates the dataset itself, computes the winning row, and requires the model's
 *     structured `result` to equal that row exactly, one citation to be bound to that row
 *     (same label and value), and the answer text to carry both.
 * A run whose answer fails any layer is a failure - no answer.json, non-zero exit.
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
  return `Which ${check.labelColumn} has the ${superlative} ${check.valueColumn} in a single row of the dataset, and what is that ${check.valueColumn} value? Put the winning ${check.labelColumn} and its exact ${check.valueColumn} in \`result\`, cite that row in \`evidence\`, and quote both in \`answer\`.`;
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

/** RFC 4180-style line split: quoted fields may contain commas and doubled quotes. */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (quoted)
    throw new Error(`csv: unterminated quote in ${JSON.stringify(line)}`);
  cells.push(cell);
  return cells.map((c) => c.trim());
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
    const lines = content.split(/\r?\n/).filter((l) => l.trim() !== "");
    const [header, ...body] = lines;
    if (header === undefined) throw new Error("csv dataset is empty");
    columns = splitCsvLine(header);
    rows = body.map(splitCsvLine);
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

export type Expected = { label: string; value: string };

/** The winning row; every candidate row must have a non-empty label and a numeric value. */
export function expectedExtreme(table: Table, check: ExtremeCheck): Expected {
  const labelAt = table.columns.indexOf(check.labelColumn);
  const valueAt = table.columns.indexOf(check.valueColumn);
  if (labelAt === -1 || valueAt === -1) {
    throw new Error(
      `dataset has no ${check.labelColumn} / ${check.valueColumn} columns`,
    );
  }
  let best: { label: string; value: number; raw: string } | undefined;
  table.rows.forEach((row, i) => {
    const raw = row[valueAt] ?? "";
    const label = row[labelAt] ?? "";
    const value = Number(raw);
    if (raw === "" || !Number.isFinite(value)) {
      throw new Error(
        `dataset row ${i}: ${check.valueColumn} ${JSON.stringify(raw)} is not numeric`,
      );
    }
    if (label === "")
      throw new Error(`dataset row ${i}: empty ${check.labelColumn}`);
    const better =
      best === undefined ||
      (check.op === "max" ? value > best.value : value < best.value);
    if (better) best = { label, value, raw };
  });
  if (best === undefined) throw new Error("dataset has no rows");
  return { label: best.label, value: best.raw };
}

export type Verdict = { ok: boolean; problems: string[]; expected?: Expected };

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
 * The gate `runAgent` applies before it reports success. With a `check` the model's structured
 * `result` must equal the computed row, a citation must be bound to that row, and the answer
 * text must name both; without one, the citations alone decide.
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
    (e) => e.value === expected.value && e.label.includes(expected.label),
  );
  if (!bound)
    problems.push(`no citation bound to ${expected.label}=${expected.value}`);
  if (
    !analysis.answer.includes(expected.label) ||
    !analysis.answer.includes(expected.value)
  ) {
    problems.push(
      `answer does not quote ${expected.label} and ${expected.value}`,
    );
  }
  return { ok: problems.length === 0, problems, expected };
}
