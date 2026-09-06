#!/usr/bin/env bash
# scripts/audit-no-mocks.sh - SC-009 gate (tasks.md T017 / T122, constitution principle III).
#
# The core demo path must run against the real Hedera Testnet, the real x402 facilitator and
# real LLM inference. This script greps the core-path sources for mocking libraries, stub /
# fake / hardcoded-response markers and test-mode bypass switches, and fails when any appear.
#
# Usage:
#   bash scripts/audit-no-mocks.sh            # warn when a listed core path is not present yet
#   AUDIT_STRICT=1 bash scripts/audit-no-mocks.sh   # missing core path is a failure (T122 final pass)
#
# Exit codes: 0 clean, 1 forbidden pattern found, 2 core path missing under AUDIT_STRICT=1,
#             3 could not enter the repository root.
set -u

cd "$(dirname "$0")/.." || exit 3

# Core paths from tasks.md T122 (keep in sync when the layout changes).
CORE_PATHS=(
  apps/gateway/src/chain
  apps/gateway/src/keygate/release.ts
  apps/gateway/src/x402
  apps/gateway/src/mcp/tools
  apps/agent/src/analyze.ts
)

# Mocking libraries, stub / fake markers, hardcoded-response markers, test-mode bypasses.
# Explicit boundaries instead of \b so BSD grep (macOS) and GNU grep (CI) agree.
PATTERN='(vi\.(mock|fn|spyOn|stubEnv|stubGlobal)|jest\.(mock|fn|spyOn)|(^|[^A-Za-z0-9_])(sinon|nock|msw|mockttp|testdouble)([^A-Za-z0-9_]|$)|(^|[^A-Za-z0-9_])(mock|stub|fake|dummy)[A-Za-z0-9_]*|(^|[^A-Za-z0-9_])(hardcoded|hard-coded|canned)([^A-Za-z0-9_]|$)|(MOCK|FAKE|STUB|SKIP_CHAIN|SKIP_SETTLEMENT|SKIP_LLM)[A-Z0-9_]*|NODE_ENV.*(test|ci)|import\.meta\.env\.(MODE|TEST|VITEST)|process\.env\.(VITEST|CI)[^A-Za-z0-9_])'

missing=0
hits=0
scanned=0

for path in "${CORE_PATHS[@]}"; do
  if [ ! -e "$path" ]; then
    missing=$((missing + 1))
    if [ "${AUDIT_STRICT:-0}" = "1" ]; then
      echo "::error::[audit-no-mocks] core path missing: $path"
    else
      echo "::warning::[audit-no-mocks] core path not present yet (BLOCKED, not verified): $path"
    fi
    continue
  fi
  scanned=$((scanned + 1))
  # Test files that live next to the sources are out of scope (they are allowed to mock).
  if out=$(grep -rEn --include='*.ts' --include='*.tsx' --exclude='*.test.ts' --exclude='*.spec.ts' --exclude='*.d.ts' -i -e "$PATTERN" -- "$path"); then
    hits=$((hits + 1))
    echo "::error::[audit-no-mocks] forbidden pattern in core path: $path"
    printf '%s\n' "$out"
  fi
done

echo "[audit-no-mocks] scanned=$scanned core paths, missing=$missing, paths_with_hits=$hits"

if [ "$hits" -gt 0 ]; then
  echo "[audit-no-mocks] FAIL - remove mocks / stubs / hardcoded responses from the core path (SC-009)."
  exit 1
fi
if [ "$missing" -gt 0 ] && [ "${AUDIT_STRICT:-0}" = "1" ]; then
  echo "[audit-no-mocks] BLOCKED - $missing core path(s) missing; cannot claim SC-009."
  exit 2
fi
echo "[audit-no-mocks] PASS - no mock / stub / hardcoded-response markers in the scanned core paths."
exit 0
