import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Funded Hedera Testnet accounts produced by `apps/contracts/scripts/seed.ts` (T048).
 * The file `.accounts.json` is gitignored; it is the only place test keys live.
 */
export type TestAccountRole =
  | "creator"
  | "ownerA"
  | "ownerB"
  | "buyer"
  | "agent";

export type TestAccount = {
  role: TestAccountRole;
  address: `0x${string}`;
  privateKey: `0x${string}`;
};

export type TestAccounts = Record<TestAccountRole, TestAccount>;

const ROLES: readonly TestAccountRole[] = [
  "creator",
  "ownerA",
  "ownerB",
  "buyer",
  "agent",
];

export function loadTestAccounts(
  path = resolve(import.meta.dirname, ".accounts.json"),
): TestAccounts {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<TestAccounts>;
  for (const role of ROLES) {
    const account = raw[role];
    if (account === undefined || !account.privateKey.startsWith("0x")) {
      throw new Error(
        `.accounts.json is missing a funded "${role}" account; run seed.ts first`,
      );
    }
  }
  return raw as TestAccounts;
}
