import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ERROR_HTTP_STATUS,
  ErrorCode,
  PAID_LICENSE_TRANSFER_OK,
  SOLIDITY_ERROR_TO_CODE,
} from "../src/errors";

/**
 * T039: the ErrorCode list is a public contract. This test cross-references
 *   (1) contracts/error-codes.md  - every code + HTTP status in the two tables
 *   (2) contracts/solidity-interfaces.md - every `error X(); // -> CODE` line
 *   (3) apps/contracts/contracts/interfaces/*.sol (once present) - custom error names
 * so that a rename in any one place is caught.
 */
const specDir = resolve(
  import.meta.dirname,
  "../../../specs/001-rights-runtime-mvp/contracts",
);
const errorCodesMd = readFileSync(resolve(specDir, "error-codes.md"), "utf8");
const registryInterfaceSol = readFileSync(
  resolve(
    import.meta.dirname,
    "../../../apps/contracts/contracts/interfaces/IRightsRegistry.sol",
  ),
  "utf8",
);
const solidityInterfacesMd = readFileSync(
  resolve(specDir, "solidity-interfaces.md"),
  "utf8",
);

type SpecRow = { code: string; http: number };

function parseSpecRows(markdown: string): SpecRow[] {
  const rows: SpecRow[] = [];
  for (const line of markdown.split("\n")) {
    // | 1 | `RECEIPT_ALREADY_CONSUMED` | 409 | ...   or   | `NONCE_INVALID_OR_EXPIRED` | 401 | ...
    const match = line.match(
      /^\|\s*(?:\d+\s*\|\s*)?`([A-Z_]+)`[^|]*\|\s*(\d{3})\s*\|/,
    );
    if (match?.[1] !== undefined && match[2] !== undefined) {
      rows.push({ code: match[1], http: Number.parseInt(match[2], 10) });
    }
  }
  return rows;
}

describe("ErrorCode stability against the spec", () => {
  const specRows = parseSpecRows(errorCodesMd);

  it("should have parsed the spec tables (guard against a silent empty parse)", () => {
    expect(specRows.length).toBeGreaterThanOrEqual(24);
  });

  it("should contain every code listed in error-codes.md with the same HTTP status", () => {
    for (const row of specRows) {
      if (row.code === PAID_LICENSE_TRANSFER_OK) {
        expect(row.http).toBe(200);
        continue;
      }
      expect(ErrorCode, `missing ${row.code}`).toHaveProperty(row.code);
      expect(
        ERROR_HTTP_STATUS[row.code as ErrorCode],
        `http status of ${row.code}`,
      ).toBe(row.http);
    }
  });

  it("should not define codes that the spec does not list (except NOT_AUTHORIZED from the Solidity contract)", () => {
    const specCodes = new Set(specRows.map((r) => r.code));
    for (const code of Object.values(ErrorCode)) {
      if (code === ErrorCode.NOT_AUTHORIZED) continue;
      expect(specCodes.has(code), `${code} is not in error-codes.md`).toBe(
        true,
      );
    }
  });

  it("should map every Solidity custom error annotated in solidity-interfaces.md", () => {
    const annotated = [
      ...solidityInterfacesMd.matchAll(
        /error\s+([A-Za-z]+)\(\);\s*\/\/\s*→\s*([A-Z_]+)/g,
      ),
    ];
    expect(annotated.length).toBeGreaterThanOrEqual(12);
    for (const [, solidityName, code] of annotated) {
      expect(
        SOLIDITY_ERROR_TO_CODE[solidityName as string],
        `mapping for ${solidityName}`,
      ).toBe(code);
    }
  });

  it("should map every annotated custom error in apps/contracts IRightsRegistry.sol", () => {
    const annotated = [
      ...registryInterfaceSol.matchAll(
        /error\s+([A-Za-z]+)\(\);\s*\/\/\s*->\s*([A-Z_]+)/g,
      ),
    ];
    expect(annotated.length).toBeGreaterThanOrEqual(13);
    for (const [, solidityName, code] of annotated) {
      expect(
        SOLIDITY_ERROR_TO_CODE[solidityName as string],
        `mapping for ${solidityName}`,
      ).toBe(code);
      expect(ErrorCode, `code ${code} exists`).toHaveProperty(code as string);
    }
  });
});
