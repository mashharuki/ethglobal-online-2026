import type { Analysis, Evidence } from "./analyze";

/**
 * Independent verification of the model's answer (SC-007: the run is only a success when the
 * answer is *about the decrypted data*). Two layers, both computed here without the model:
 *  1. every citation must be non-empty and appear verbatim in the dataset;
 *  2. for a deterministic question ("which <label> has the highest <value>?") the harness
 *     computes the expected row itself and requires the answer AND the evidence to carry it.
 * A run whose answer fails either layer is a failure - no answer.json, non-zero exit.
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
  return `Which ${check.labelColumn} has the ${superlative} ${check.valueColumn} in a single row of the dataset, and what is that ${check.valueColumn} value? Quote the exact ${check.labelColumn} and the exact number.`;
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

type Table = { columns: string[]; rows: unknown[][] };

/** `{columns, rows}` JSON (the seed format) or a CSV with a header row. */
export function parseTable(format: string, content: string): Table {
  if (format === "json") {
    const parsed = JSON.parse(content) as { columns?: unknown; rows?: unknown };
    if (!Array.isArray(parsed.columns) || !Array.isArray(parsed.rows)) {
      throw new Error("json dataset has no columns/rows table");
    }
    return {
      columns: parsed.columns.map(String),
      rows: parsed.rows.map((r) => (Array.isArray(r) ? r : [])),
    };
  }
  if (format === "csv") {
    const lines = content.split(/\r?\n/).filter((l) => l.trim() !== "");
    const [header, ...body] = lines;
    if (header === undefined) throw new Error("csv dataset is empty");
    return {
      columns: header.split(",").map((c) => c.trim()),
      rows: body.map((l) => l.split(",").map((c) => c.trim())),
    };
  }
  throw new Error(`cannot tabulate a ${format} dataset`);
}

export type Expected = { label: string; value: string };

export function expectedExtreme(table: Table, check: ExtremeCheck): Expected {
  const labelAt = table.columns.indexOf(check.labelColumn);
  const valueAt = table.columns.indexOf(check.valueColumn);
  if (labelAt === -1 || valueAt === -1) {
    throw new Error(
      `dataset has no ${check.labelColumn} / ${check.valueColumn} columns`,
    );
  }
  let best: { label: string; value: number; raw: string } | undefined;
  for (const row of table.rows) {
    const raw = String(row[valueAt] ?? "");
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    const better =
      best === undefined ||
      (check.op === "max" ? value > best.value : value < best.value);
    if (better) best = { label: String(row[labelAt] ?? ""), value, raw };
  }
  if (best === undefined)
    throw new Error(`no numeric ${check.valueColumn} in the dataset`);
  return { label: best.label, value: best.raw };
}

export type Verdict = { ok: boolean; problems: string[]; expected?: Expected };

function citationProblems(evidence: Evidence[], dataset: string): string[] {
  const problems: string[] = [];
  if (evidence.length === 0) problems.push("no evidence cited");
  for (const e of evidence) {
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
 * The gate `runAgent` applies before it reports success. `check` is skipped only when the
 * dataset cannot be tabulated for it (then layer 1 alone decides, and the verdict says so).
 */
export function verifyAnalysis(
  analysis: Analysis,
  dataset: { format: string; content: string },
  check: ExtremeCheck | undefined,
): Verdict {
  const problems = citationProblems(analysis.evidence, dataset.content);
  if (check === undefined) return { ok: problems.length === 0, problems };
  const expected = expectedExtreme(
    parseTable(dataset.format, dataset.content),
    check,
  );
  if (!analysis.answer.includes(expected.label)) {
    problems.push(
      `answer does not name ${check.labelColumn} "${expected.label}"`,
    );
  }
  if (!analysis.answer.includes(expected.value)) {
    problems.push(
      `answer does not carry ${check.valueColumn} ${expected.value}`,
    );
  }
  if (!analysis.evidence.some((e) => e.value === expected.value)) {
    problems.push(`evidence does not cite ${expected.value}`);
  }
  return { ok: problems.length === 0, problems, expected };
}
