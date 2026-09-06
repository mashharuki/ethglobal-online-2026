import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { type Analysis, analyzeDataset } from "./analyze";
import {
  connectRightsRuntime,
  type DiscoveredAsset,
  type Hex,
} from "./mcpClient";
import {
  type ExtremeCheck,
  parseCheck,
  questionFor,
  type Verdict,
  verifyAnalysis,
} from "./verify";

/**
 * apps/agent - CI verification harness entrypoint (tasks.md T120, SC-007 / SC-009).
 *
 * `pnpm --filter agent start -- [--question "<question>"] [--asset 0x…] [--out path]`
 *
 * Connects to `${GATEWAY_URL}/mcp`, runs discover_assets -> buy_access -> decrypt_content on
 * the live gateway (real x402 settlement through the gateway's Privy server wallet, real
 * KeyGate), asks Claude to analyze the decrypted dataset, verifies the answer against the data
 * itself, and only then writes the run to `apps/agent/out/answer.json`. There is no prompt,
 * no confirmation and no retry loop that a human would drive: one process, zero human
 * intervention. Inference configuration is checked BEFORE any HBAR is spent.
 */
export type Step = { step: string; at: string; ms: number };

export type AnswerRecord = {
  question: string;
  gatewayUrl: string;
  mcpSession: string;
  asset: DiscoveredAsset;
  receiptHash: Hex;
  onchainTx: { settle: string; consume: string };
  useIndex: number;
  dataset: { format: string; chars: number; truncated: boolean };
  model: string;
  /** the model's free text + citations (kept for the record, NOT the verified artifact) */
  analysis: Analysis;
  verification: Verdict;
  /** the harness-generated conclusion, present only when verification passed */
  verifiedAnswer?: string;
  steps: Step[];
};

export type AgentArgs = { question?: string; assetId?: Hex; out?: string };

const FLAGS = new Set(["--question", "--asset", "--out"]);

/**
 * Strict argv: only `--flag value` pairs of the three known flags, each at most once. Anything
 * else (`--asset=0x…`, an unknown flag, a missing value, a duplicate) is an error - never a
 * silent fall-through to "buy the first listed asset".
 */
export function parseArgs(argv: readonly string[]): AgentArgs {
  const seen = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? "";
    if (!FLAGS.has(flag))
      throw new Error(`unsupported argument ${JSON.stringify(flag)}`);
    if (seen.has(flag)) throw new Error(`${flag} given twice`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`${flag} needs a value`);
    seen.set(flag, value);
    i += 1;
  }
  const asset = seen.get("--asset");
  if (asset !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(asset)) {
    throw new Error("--asset must be a bytes32 assetId (0x + 64 hex)");
  }
  return {
    question: seen.get("--question"),
    assetId: asset as Hex | undefined,
    out: seen.get("--out"),
  };
}

/** The first asset with a paid offer (or the one named): discovery only, never authorization. */
export function chooseAsset(
  assets: DiscoveredAsset[],
  assetId?: Hex,
): DiscoveredAsset {
  const chosen =
    assetId === undefined
      ? assets.find((a) => a.paidAccess.maxUses > 0)
      : assets.find((a) => a.assetId.toLowerCase() === assetId.toLowerCase());
  if (chosen === undefined) {
    throw new Error(
      assetId === undefined
        ? "discover_assets returned no purchasable asset"
        : `asset ${assetId} is not listed by discover_assets`,
    );
  }
  return chosen;
}

export class VerificationError extends Error {
  override readonly name = "VerificationError";
  readonly record: AnswerRecord;
  constructor(record: AnswerRecord) {
    super(
      `answer failed verification: ${record.verification.problems.join("; ")}`,
    );
    this.record = record;
  }
}

export async function runAgent(input: {
  gatewayUrl: string;
  question?: string;
  /** deterministic check the answer must satisfy; undefined = citations only */
  check?: ExtremeCheck;
  assetId?: Hex;
  anthropic?: Anthropic;
  log?: (line: string) => void;
}): Promise<AnswerRecord> {
  const log = input.log ?? (() => {});
  // inference must be configured before a single tinybar moves (throws without an API key)
  const anthropic = input.anthropic ?? new Anthropic();
  const question =
    input.question ??
    (input.check === undefined ? undefined : questionFor(input.check));
  if (question === undefined)
    throw new Error("a --question or an AGENT_CHECK is required");

  const steps: Step[] = [];
  const started = performance.now();
  const mark = (step: string): void => {
    steps.push({
      step,
      at: new Date().toISOString(),
      ms: Math.round(performance.now() - started),
    });
    log(`[agent] ${step} (+${steps.at(-1)?.ms}ms)`);
  };

  const mcpUrl = `${input.gatewayUrl.replace(/\/$/, "")}/mcp`;
  const runtime = await connectRightsRuntime(mcpUrl);
  try {
    mark(`connected ${mcpUrl}`);
    const assets = await runtime.discoverAssets();
    const asset = chooseAsset(assets, input.assetId);
    mark(
      `discover_assets: ${assets.length} listed, chose token #${asset.tokenId}`,
    );

    const bought = await runtime.buyAccess(asset.assetId);
    mark(`buy_access: receipt ${bought.receiptHash} (tx ${bought.onchainTx})`);

    const decrypted = await runtime.decryptContent(
      asset.assetId,
      bought.receiptHash,
    );
    mark(
      `decrypt_content: use #${decrypted.useIndex}, ${decrypted.dataset.content.length} chars of ${decrypted.dataset.format}`,
    );

    const { analysis, model, truncated } = await analyzeDataset({
      question,
      dataset: decrypted.dataset,
      client: anthropic,
    });
    mark(
      `analyze (${model}): ${analysis.confidence} confidence, ${analysis.evidence.length} evidence`,
    );

    const verification = verifyAnalysis(
      analysis,
      decrypted.dataset,
      input.check,
    );
    mark(
      `verify: ${verification.ok ? "grounded" : verification.problems.join("; ")}`,
    );

    const record: AnswerRecord = {
      question,
      gatewayUrl: input.gatewayUrl,
      mcpSession: runtime.sessionId,
      asset,
      receiptHash: bought.receiptHash,
      onchainTx: { settle: bought.onchainTx, consume: decrypted.onchainTx },
      useIndex: decrypted.useIndex,
      dataset: {
        format: decrypted.dataset.format,
        chars: decrypted.dataset.content.length,
        truncated,
      },
      model,
      analysis,
      verification,
      verifiedAnswer: verification.ok ? verification.statement : undefined,
      steps,
    };
    if (!verification.ok) throw new VerificationError(record);
    return record;
  } finally {
    await runtime.close();
  }
}

export const DEFAULT_OUT = resolve(import.meta.dirname, "../out/answer.json");

export function writeAnswer(record: AnswerRecord, path = DEFAULT_OUT): string {
  if (!record.verification.ok)
    throw new Error("refusing to write an unverified answer");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

const isDirectRun = process.argv[1]?.endsWith("src/index.ts") ?? false;
if (isDirectRun) {
  const usage =
    'usage: GATEWAY_URL=<url> ANTHROPIC_API_KEY=<key> [AGENT_CHECK=\'{"labelColumn","valueColumn","op"}\'] agent [--question <text>] [--asset 0x…] [--out path]';
  let args: AgentArgs;
  let check: ExtremeCheck;
  try {
    args = parseArgs(process.argv.slice(2));
    check = parseCheck(process.env.AGENT_CHECK);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    console.error(usage);
    process.exit(2);
  }
  const gatewayUrl = process.env.GATEWAY_URL ?? "";
  if (gatewayUrl === "" || (process.env.ANTHROPIC_API_KEY ?? "") === "") {
    console.error(usage);
    process.exit(2);
  }
  runAgent({
    gatewayUrl,
    question: args.question,
    check,
    assetId: args.assetId,
    log: console.error,
  })
    .then((record) => {
      const path = writeAnswer(
        record,
        args.out === undefined ? DEFAULT_OUT : resolve(args.out),
      );
      console.log(
        JSON.stringify(
          {
            verifiedAnswer: record.verifiedAnswer,
            modelText: record.analysis.answer,
            receiptHash: record.receiptHash,
            out: path,
          },
          null,
          2,
        ),
      );
    })
    .catch((error: unknown) => {
      console.error(
        "[agent] failed:",
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    });
}
