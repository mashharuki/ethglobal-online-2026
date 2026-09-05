import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

/**
 * T029 - end-to-end view of FR-001 through ethers (what the gateway's viem reads will see):
 * mint -> accessEpoch == 1, transferFrom -> +1, and the ABI exposes no setter for it.
 */
describe("RightsNFT (integration)", () => {
  async function deploy() {
    const [deployer, ownerA, ownerB] = await ethers.getSigners();
    const nft = await ethers.deployContract("RightsNFT");
    return { deployer, ownerA, ownerB, nft };
  }

  it("should start at accessEpoch 1 after mint and increment on every transfer", async () => {
    const { deployer, ownerA, ownerB, nft } = await deploy();
    const tx = await nft.mint(
      ownerA.address,
      deployer.address,
      ethers.ZeroHash,
      "ipfs://m",
    );
    await tx.wait();
    expect(await nft.accessEpoch(1n)).to.equal(1n);

    await (
      await nft.connect(ownerA).transferFrom(ownerA.address, ownerB.address, 1n)
    ).wait();
    expect(await nft.accessEpoch(1n)).to.equal(2n);
    expect(await nft.ownerOf(1n)).to.equal(ownerB.address);

    await (
      await nft.connect(ownerB).transferFrom(ownerB.address, ownerA.address, 1n)
    ).wait();
    expect(await nft.accessEpoch(1n)).to.equal(3n);
  });

  it("should expose no external function that writes accessEpoch", async () => {
    const { nft } = await deploy();
    const writers = nft.interface.fragments
      .filter((f) => f.type === "function")
      .map((f) => f.format("sighash"))
      .filter((sig) => /epoch/i.test(sig) && !sig.startsWith("accessEpoch("));
    expect(writers).to.deep.equal([]);
  });
});
