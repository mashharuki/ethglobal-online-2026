import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Funded Hedera Testnet accounts produced by `apps/contracts/scripts/seed.ts` (T048).
 * The per-chain file `.accounts.<chainId>.json` is gitignored and 0600; it is the only
 * place test keys live. Default chain is Hedera testnet (296).
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

export function accountsPath(
  chainId = Number(process.env.HEDERA_CHAIN_ID ?? "296"),
): string {
  return resolve(import.meta.dirname, `.accounts.${chainId}.json`);
}

export function loadTestAccounts(path = accountsPath()): TestAccounts {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<TestAccounts>;
  for (const role of ROLES) {
    const account = raw[role];
    if (account === undefined || !account.privateKey.startsWith("0x")) {
      throw new Error(
        `${path} is missing a funded "${role}" account; run seed first`,
      );
    }
  }
  return raw as TestAccounts;
}
