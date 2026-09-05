/**
 * apps/agent - CI verification harness entrypoint.
 *
 * Usage (tasks.md T120): `pnpm --filter agent start -- --question "<question>"`
 * Connects to `${GATEWAY_URL}/mcp`, runs discover_assets -> buy_access -> decrypt_content,
 * then asks Claude to analyze the decrypted dataset. Implemented in Phase 11.
 */
export function parseQuestion(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("--question");
  if (index === -1) {
    return undefined;
  }
  return argv[index + 1];
}

const isDirectRun = process.argv[1]?.endsWith("src/index.ts") ?? false;
if (isDirectRun) {
  const question = parseQuestion(process.argv.slice(2));
  if (question === undefined) {
    console.error("usage: agent --question <text>");
    process.exit(2);
  }
  console.error("agent harness not implemented yet (tasks.md Phase 11)");
  process.exit(1);
}
