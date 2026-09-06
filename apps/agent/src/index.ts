import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type Analysis, analyzeDataset, ungroundedEvidence } from "./analyze";
import {
  connectRightsRuntime,
  type DiscoveredAsset,
  type Hex,
} from "./mcpClient";

/**
 * apps/agent - CI verification harness entrypoint (tasks.md T120, SC-007 / SC-009).
 *
 * `pnpm --filter agent start -- --question "<question>" [--asset 0x…] [--out path]`
 *
 * Connects to `${GATEWAY_URL}/mcp`, runs discover_assets -> buy_access -> decrypt_content on
 * the live gateway (real x402 settlement through the gateway's Privy server wallet, real
 * KeyGate), asks Claude to analyze the decrypted dataset, and writes the whole run to
 * `apps/agent/out/answer.json`. There is no prompt, no confirmation and no retry loop that a
 * human would drive: one process, zero human intervention.
 */
export type Step = { step: string; at: string; ms: number };

export type AnswerRecord = {
  question: string;
  gatewayUrl: string;
  mcpSession: string | undefined;
  asset: DiscoveredAsset;
  receiptHash: Hex;
  onchainTx: { settle: string; consume: string };
  useIndex: number;
  dataset: { format: string; chars: number; truncated: boolean };
  model: string;
  analysis: Analysis;
  ungroundedEvidence: Analysis["evidence"];
  steps: Step[];
};

export type AgentArgs = { question?: string; assetId?: Hex; out?: string };

export function parseArgs(argv: readonly string[]): AgentArgs {
  const valueOf = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const asset = valueOf("--asset");
  return {
    question: valueOf("--question"),
    assetId:
      asset !== undefined && /^0x[0-9a-fA-F]{64}$/.test(asset)
        ? (asset as Hex)
        : undefined,
    out: valueOf("--out"),
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

export async function runAgent(input: {
  question: string;
  gatewayUrl: string;
  assetId?: Hex;
  log?: (line: string) => void;
}): Promise<AnswerRecord> {
  const log = input.log ?? (() => {});
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
      question: input.question,
      dataset: decrypted.dataset,
    });
    mark(
      `analyze (${model}): ${analysis.confidence} confidence, ${analysis.evidence.length} evidence`,
    );

    return {
      question: input.question,
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
      ungroundedEvidence: ungroundedEvidence(
        analysis,
        decrypted.dataset.content,
      ),
      steps,
    };
  } finally {
    await runtime.close();
  }
}

export const DEFAULT_OUT = resolve(import.meta.dirname, "../out/answer.json");

export function writeAnswer(record: AnswerRecord, path = DEFAULT_OUT): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

const isDirectRun = process.argv[1]?.endsWith("src/index.ts") ?? false;
if (isDirectRun) {
  const args = parseArgs(process.argv.slice(2));
  const gatewayUrl = process.env.GATEWAY_URL ?? "";
  if (args.question === undefined || gatewayUrl === "") {
    console.error(
      "usage: GATEWAY_URL=<url> ANTHROPIC_API_KEY=<key> agent --question <text> [--asset 0x…] [--out path]",
    );
    process.exit(2);
  }
  runAgent({
    question: args.question,
    gatewayUrl,
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
            answer: record.analysis,
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
