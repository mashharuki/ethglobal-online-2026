import { resolve } from "node:path";
import { network } from "hardhat";
import {
  HEDERA_TESTNET_CHAIN_ID,
  outDirFor,
  writeJson,
} from "./lib/deployment.js";

/**
 * tasks.md T018 - day1 probe of native HBAR value semantics on Hedera EVM (research.md R-4).
 *
 *   pnpm --filter contracts probe:hedera:local
 *   pnpm --filter contracts probe:hedera            # --network testnet
 *
 * Deploys the disposable ProbeSettle contract and records:
 *   1. msg.value unit for a 1 HBAR call (expect 1e18 weibar) and msg.value / 1e10 (expect 1e8 tinybar)
 *   2. remainder for a value that is not a multiple of 1e10 (Hedera should not be able to send it)
 *   3. mulDiv split dust in tinybar for an odd price (expect 0 dust after assigning remainder)
 *   4. `.call{value:}` payout success and the balance delta
 * Results go to out/probe-hedera.<chainId>.json and must be copied into research.md
 * "day1 probe 結果の記録欄" (R-4 row) by hand.
 */
const { ethers, networkName } = await network.getOrCreate();

const WEIBAR_PER_TINYBAR = 10_000_000_000n;
const ONE_HBAR_WEIBAR = 100_000_000n * WEIBAR_PER_TINYBAR;

async function main(): Promise<void> {
  const [signer] = await ethers.getSigners();
  if (signer === undefined)
    throw new Error("no signer configured for this network");
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const result: Record<string, unknown> = {
    chainId,
    network: networkName,
    isHederaTestnet: BigInt(chainId) === HEDERA_TESTNET_CHAIN_ID,
    signer: signer.address,
    probedAt: new Date().toISOString(),
  };

  const probe = await ethers.deployContract("ProbeSettle");
  await probe.waitForDeployment();
  result.probeAddress = await probe.getAddress();

  // 1. exact 1 HBAR through the primary-shaped entry point
  const tx1 = await probe.settleAndIssue("0x", 100_000_000n, {
    value: ONE_HBAR_WEIBAR,
  });
  const r1 = await tx1.wait();
  const received = r1?.logs
    .map((log) => {
      try {
        return probe.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed?.name === "Received");
  result.oneHbar = {
    txHash: tx1.hash,
    msgValueWeibar: received?.args.msgValueWeibar.toString(),
    priceTinybar: received?.args.priceTinybar.toString(),
    remainderWeibar: received?.args.remainderWeibar.toString(),
    lastMsgValue: (await probe.lastMsgValue()).toString(),
  };

  // 2. sub-tinybar value (1e10 + 1 weibar). On Hedera this is expected to be rejected or truncated.
  try {
    const tx2 = await probe.payFor(ethers.id("sub-tinybar"), {
      value: WEIBAR_PER_TINYBAR + 1n,
    });
    const r2 = await tx2.wait();
    result.subTinybar = {
      txHash: tx2.hash,
      status: r2?.status,
      lastMsgValue: (await probe.lastMsgValue()).toString(),
    };
  } catch (error) {
    result.subTinybar = {
      error: String((error as Error).message).slice(0, 300),
    };
  }

  // 3. odd price split in tinybar
  const odd = 333_333_333n;
  const split = await probe.splitProbe.staticCall(odd, 3000, 7000);
  result.split = {
    priceTinybar: odd.toString(),
    creatorTinybar: split[0].toString(),
    ownerTinybar: split[1].toString(),
    sumEqualsPrice: split[0] + split[1] === odd,
  };

  // 4. payout via .call{value:}
  const before = await ethers.provider.getBalance(signer.address);
  const tx4 = await probe.withdraw();
  const r4 = await tx4.wait();
  const after = await ethers.provider.getBalance(signer.address);
  const paidOut = r4?.logs
    .map((log) => {
      try {
        return probe.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed?.name === "PaidOut");
  result.payout = {
    txHash: tx4.hash,
    ok: paidOut?.args.ok,
    amountWeibar: paidOut?.args.amountWeibar.toString(),
    balanceDeltaWeibar: (after - before).toString(), // net of gas; positive means payout > gas
  };

  const outPath = resolve(outDirFor(chainId), "probe-hedera.json");
  writeJson(outPath, result);
  console.log(JSON.stringify(result, null, 2));
  console.log(`wrote ${outPath}`);
}

await main();
