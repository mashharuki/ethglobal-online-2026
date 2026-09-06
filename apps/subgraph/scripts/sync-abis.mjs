// Copies the compiled ABIs from apps/contracts (Hardhat artifacts) into abis/ so the subgraph
// can be built and deployed without a contracts build on the same machine.
//   pnpm --filter subgraph sync-abis   (run after `pnpm --filter contracts compile`)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const contractsArtifacts = resolve(here, "../../contracts/artifacts/contracts");
const abisDir = resolve(here, "../abis");
mkdirSync(abisDir, { recursive: true });

for (const name of ["RightsNFT", "RightsRegistry"]) {
  const artifactPath = resolve(contractsArtifacts, `${name}.sol/${name}.json`);
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  if (!Array.isArray(artifact.abi)) throw new Error(`no abi in ${artifactPath}`);
  const out = resolve(abisDir, `${name}.json`);
  writeFileSync(out, `${JSON.stringify(artifact.abi, null, 2)}\n`);
  console.log(`wrote ${out} (${artifact.abi.length} entries)`);
}
