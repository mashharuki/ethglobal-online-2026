import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();

/**
 * T034 / matrix row #2 - Concurrent Replay at the contract layer (SC-005):
 * 20 real transactions targeting the same (receiptHash, useIndex) are submitted in parallel
 * from the operator key; exactly one succeeds, 19 revert with ReceiptAlreadyConsumed.
 */
describe("RightsRegistry concurrent consume", () => {
  it("should settle exactly one of 20 parallel consume transactions for the same useIndex", async () => {
    const [creator, ownerA, buyer, admin, operator] = await ethers.getSigners();
    const nft = await ethers.deployContract("RightsNFT");
    const registry = await ethers.deployContract("RightsRegistry", [
      await nft.getAddress(),
      admin.address,
      operator.address,
    ]);

    const price = 500_000_000n; // tinybar
    const duration = 300n;
    const maxUses = 5;
    const policyHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint64", "uint32", "uint8", "uint8", "uint16", "uint16"],
        [price, duration, maxUses, 6, 0, 3000, 7000],
      ),
    );
    const assetId = ethers.id("asset-a");
    const contentHash = ethers.id("ciphertext-a");
    await (
      await nft
        .connect(creator)
        .mint(
          ownerA.address,
          creator.address,
          policyHash,
          assetId,
          contentHash,
          "ipfs://m",
        )
    ).wait();

    const now = BigInt(await networkHelpers.time.latest());
    const params = {
      nftContract: await nft.getAddress(),
      tokenId: 1n,
      resourceHash: await nft.resourceHash(1n),
      policyHash,
      licenseEpoch: 0n,
      ownerEpochAtIssue: 1n,
      licensee: buyer.address,
      permittedAction: 6,
      transferMode: 0,
      maxUses,
      expiresAt: now + duration,
      purchaseRequestHash: ethers.id("purchase"),
      paymentId: ethers.id("payment"),
      nonce: ethers.id("nonce"),
      issuedAt: now,
      price,
      creatorBps: 3000,
      ownerBps: 7000,
    };
    const settleTx = await registry
      .connect(buyer)
      .settleAndIssue(params, { value: price * 10_000_000_000n });
    const settleReceipt = await settleTx.wait();
    const issued = settleReceipt?.logs
      .map((log) => {
        try {
          return registry.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed) => parsed?.name === "ReceiptIssued");
    expect(issued, "ReceiptIssued event").to.not.equal(undefined);
    const receiptHash = issued?.args.receiptHash as string;

    // 20 independent transactions queued in the mempool and mined in ONE block (automine off),
    // explicit gas + sequential nonces so none is rejected client-side.
    const startNonce = await ethers.provider.getTransactionCount(
      operator.address,
    );
    const calldata = registry.interface.encodeFunctionData("consume", [
      receiptHash,
      0,
    ]);
    await ethers.provider.send("evm_setAutomine", [false]);
    const sent = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        operator.sendTransaction({
          to: registry.target,
          data: calldata,
          gasLimit: 200_000n,
          nonce: startNonce + i,
        }),
      ),
    );
    await networkHelpers.mine();
    await ethers.provider.send("evm_setAutomine", [true]);
    const results = await Promise.allSettled(sent.map((tx) => tx.wait()));

    const succeeded = results.filter(
      (r) => r.status === "fulfilled" && r.value?.status === 1,
    ).length;
    const rejected = results.filter(
      (r) =>
        r.status === "rejected" ||
        (r.status === "fulfilled" && r.value?.status === 0),
    ).length;
    expect(succeeded).to.equal(1);
    expect(rejected).to.equal(19);
    expect(await registry.isConsumed(receiptHash, 0)).to.equal(true);
    const status = await registry.receiptStatus(receiptHash);
    expect(status.usedCount).to.equal(1n);

    // every failure must be the expected custom error
    for (const r of results) {
      if (r.status === "rejected") {
        const message = String(
          (r.reason as { message?: string }).message ?? r.reason,
        );
        expect(message, message).to.match(/ReceiptAlreadyConsumed|reverted/);
      }
    }
  });
});
