#!/usr/bin/env bash
# No-mocks audit for the core demo path (tasks.md T017 / T122, SC-009, constitution III).
#
# The core path must run against real Hedera Testnet, a real x402 settlement, real KeyGate
# material and real LLM inference. This script greps the SOURCE of that path (never its tests)
# for mock / stub / fake / hard-coded-response vocabulary and fails on any hit, listing them.
# It is deliberately dumb and loud: a false positive is fixed by renaming, not by weakening
# the pattern. Run: `pnpm run audit:no-mocks` (CI runs it on every push / PR).
set -u

cd "$(dirname "$0")/.." || exit 2

CORE_PATHS=(
  "apps/gateway/src/chain"
  "apps/gateway/src/keygate/release.ts"
  "apps/gateway/src/x402"
  "apps/gateway/src/mcp/tools"
  "apps/agent/src/analyze.ts"
)

# word-bounded, case-insensitive; `vi.mock` / `jest.mock` are the test doubles of the stack,
# the plain words catch hand-rolled ones and "hardcoded response" comments
PATTERN='\b(vi\.mock|jest\.mock|sinon|nock|msw|mock|mocks|mocked|stub|stubs|stubbed|fake|fakes|faked|hardcoded|hard-coded)\b'

missing=0
for p in "${CORE_PATHS[@]}"; do
  if [ ! -e "$p" ]; then
    echo "[audit-no-mocks] MISSING core path: $p (the audit cannot cover what does not exist)"
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  echo "[audit-no-mocks] BLOCKED: core path list is out of date"
  exit 2
fi

hits="$(grep -rniE --include='*.ts' --include='*.sol' "$PATTERN" "${CORE_PATHS[@]}" || true)"
if [ -n "$hits" ]; then
  echo "[audit-no-mocks] FAIL: mock / stub / fake vocabulary in the core path:"
  printf '%s\n' "$hits"
  exit 1
fi

count="$(find "${CORE_PATHS[@]}" -type f \( -name '*.ts' -o -name '*.sol' \) | wc -l | tr -d ' ')"
if [ "$count" -eq 0 ]; then
  echo "[audit-no-mocks] BLOCKED: no source files under the core paths"
  exit 2
fi
echo "[audit-no-mocks] PASS: $count core-path files, no mock / stub / fake vocabulary"
