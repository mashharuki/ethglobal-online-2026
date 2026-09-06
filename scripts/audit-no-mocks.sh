#!/usr/bin/env bash
# No-mocks audit for the core demo path (tasks.md T017 / T122, SC-009, constitution III).
#
# The core path must run against real Hedera Testnet, a real x402 settlement, real KeyGate
# material and real LLM inference. This script greps the SOURCE of that path (never its tests)
# for test-double vocabulary and fails on any hit, listing them. It is deliberately dumb and
# loud: a comment such as "never mock this" also trips it, and the fix is to reword, not to
# weaken the pattern. Scope: this is a vocabulary scan; it proves the core source does not
# declare test doubles, not that every dependency is real - the constitution-III evidence for
# that is the live CI jobs and the README verification status.
#
# Exit codes: 0 PASS, 1 FAIL (hits listed), 2 BLOCKED (a core path missing / empty, or the scan
# itself could not run - never reported as a pass).
# Run: `pnpm run audit:no-mocks`. AUDIT_CORE_PATHS (space-separated) overrides the path list,
# used by the self-test only.
set -u

cd "$(dirname "$0")/.." || exit 2

if [ -n "${AUDIT_CORE_PATHS:-}" ]; then
  # shellcheck disable=SC2206 # intentional word-splitting of a space-separated list
  CORE_PATHS=(${AUDIT_CORE_PATHS})
else
  CORE_PATHS=(
    "apps/gateway/src/chain"
    "apps/gateway/src/keygate/release.ts"
    "apps/gateway/src/x402"
    "apps/gateway/src/mcp/tools"
    "apps/agent/src/analyze.ts"
  )
fi

# word-start anchored so mockResolvedValue / mockResponse / stubbed / fakeFetch are caught too
PATTERN='\b(vi\.(mock|fn|spyOn)|jest\.(mock|fn|spyOn)|spyOn|sinon|nock|msw|mock[A-Za-z_]*|stub[A-Za-z_]*|fake[A-Za-z_]*|hardcoded|hard-coded)\b'

blocked=0
for p in "${CORE_PATHS[@]}"; do
  if [ ! -e "$p" ]; then
    echo "[audit-no-mocks] BLOCKED: missing core path $p (the audit cannot cover what does not exist)"
    blocked=1
    continue
  fi
  # every core path must contribute at least one NON-EMPTY source file
  nonempty="$(find "$p" -type f \( -name '*.ts' -o -name '*.sol' \) -size +0 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "[audit-no-mocks] BLOCKED: cannot traverse $p: $nonempty"
    blocked=1
  elif [ -z "$nonempty" ]; then
    echo "[audit-no-mocks] BLOCKED: no non-empty source under $p"
    blocked=1
  fi
done
[ "$blocked" -eq 0 ] || exit 2

# grep: 0 = hits, 1 = clean, anything else = the scan itself failed (BLOCKED, not PASS)
hits="$(grep -rniE --include='*.ts' --include='*.sol' "$PATTERN" "${CORE_PATHS[@]}" 2>&1)"
rc=$?
case "$rc" in
  0)
    echo "[audit-no-mocks] FAIL: test-double vocabulary in the core path:"
    printf '%s\n' "$hits"
    exit 1
    ;;
  1) ;;
  *)
    echo "[audit-no-mocks] BLOCKED: grep exited $rc: $hits"
    exit 2
    ;;
esac

count=0
for p in "${CORE_PATHS[@]}"; do
  n="$(find "$p" -type f \( -name '*.ts' -o -name '*.sol' \) -size +0 | wc -l | tr -d ' ')"
  count=$((count + n))
done
echo "[audit-no-mocks] PASS: $count non-empty core-path files across ${#CORE_PATHS[@]} paths, no test-double vocabulary"
