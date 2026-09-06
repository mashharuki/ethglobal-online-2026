#!/usr/bin/env bash
# scripts/audit-no-mocks.sh - SC-009 gate (tasks.md T017 / T122, constitution principle III).
#
# The core demo path must run against the real Hedera Testnet, the real x402 facilitator and
# real LLM inference. This script greps the core-path sources for mocking libraries, stub /
# fake / hardcoded-response markers and test-mode bypass switches, and fails when any appear.
#
# Scope: this is a MARKER gate (cheap, deterministic, runs on every CI push). It cannot prove
# behaviour - an unmarked canned implementation passes it. Behavioural proof against the real
# services is the job of the E2E gates (tasks.md T099 / T119 / T121); this script only stops
# the obvious regressions between those runs.
#
# Usage:
#   bash scripts/audit-no-mocks.sh                  # warn when a listed core path has no sources yet
#   AUDIT_STRICT=1 bash scripts/audit-no-mocks.sh   # missing core path is a failure (CI, T122 final pass)
#   AUDIT_CORE_PATHS="p1 p2" bash scripts/...       # override the core-path list (self-test only)
#
# Exit codes: 0 clean, 1 forbidden pattern found, 2 core path missing under AUDIT_STRICT=1,
#             3 could not enter the repository root, 4 grep failed (result unknown = BLOCKED).
set -u

cd "$(dirname "$0")/.." || exit 3

# Core paths from tasks.md T122 (keep in sync when the layout changes).
if [ -n "${AUDIT_CORE_PATHS:-}" ]; then
  # shellcheck disable=SC2206 # intentional word split: space-separated list, self-test only
  CORE_PATHS=(${AUDIT_CORE_PATHS})
else
  CORE_PATHS=(
    apps/gateway/src/chain
    apps/gateway/src/keygate/release.ts
    apps/gateway/src/x402
    apps/gateway/src/mcp/tools
    apps/agent/src/analyze.ts
  )
fi

# Case-sensitive on purpose: a leading boundary + explicit lower / Pascal / UPPER forms keep
# production identifiers such as Cloudflare's `DurableObjectStub` (stub mid-word) out, while
# `mockClient`, `StubFacilitator`, `FAKE_SETTLEMENT` still hit. Boundaries are spelled out
# instead of \b so BSD grep (macOS) and GNU grep (CI) agree.
B='(^|[^A-Za-z0-9_])'
E='([^A-Za-z0-9_]|$)'
PATTERN="vi\\.(mock|fn|spyOn|stubEnv|stubGlobal)${E}"
PATTERN="${PATTERN}|jest\\.(mock|fn|spyOn)${E}"
PATTERN="${PATTERN}|${B}(sinon|nock|msw|mockttp|testdouble)${E}"
PATTERN="${PATTERN}|${B}(mock|stub|fake|dummy|Mock|Stub|Fake|Dummy)[A-Za-z0-9_]*"
PATTERN="${PATTERN}|${B}(MOCK|FAKE|STUB|DUMMY|SKIP_CHAIN|SKIP_SETTLEMENT|SKIP_LLM)[A-Z0-9_]*"
PATTERN="${PATTERN}|${B}(hardcoded|hard-coded|canned|Hardcoded|HARDCODED)${E}"
PATTERN="${PATTERN}|NODE_ENV.*(test|ci)"
PATTERN="${PATTERN}|import\\.meta\\.env\\.(MODE|TEST|VITEST)${E}"
PATTERN="${PATTERN}|process\\.env\\.(VITEST|CI)${E}"

missing=0
hits=0
scanned=0
errors=0

for path in "${CORE_PATHS[@]}"; do
  # Eligible sources: .ts / .tsx excluding colocated tests and declaration files. An absent
  # path, an empty directory or a directory holding only excluded files are all "nothing to
  # audit" - never counted as scanned (a green run must mean sources were actually read).
  files=()
  if [ -e "$path" ]; then
    while IFS= read -r -d '' f; do
      files+=("$f")
    done < <(find "$path" -type f \( -name '*.ts' -o -name '*.tsx' \) \
      ! -name '*.test.ts' ! -name '*.spec.ts' ! -name '*.test.tsx' ! -name '*.spec.tsx' \
      ! -name '*.d.ts' -print0)
  fi

  if [ "${#files[@]}" -eq 0 ]; then
    missing=$((missing + 1))
    if [ "${AUDIT_STRICT:-0}" = "1" ]; then
      echo "::error::[audit-no-mocks] core path has no auditable sources: $path"
    else
      echo "::warning::[audit-no-mocks] core path has no auditable sources yet (BLOCKED, not verified): $path"
    fi
    continue
  fi

  out=$(grep -EnH -e "$PATTERN" -- "${files[@]}")
  rc=$?
  case "$rc" in
    0)
      hits=$((hits + 1))
      scanned=$((scanned + 1))
      echo "::error::[audit-no-mocks] forbidden pattern in core path: $path"
      printf '%s\n' "$out"
      ;;
    1)
      scanned=$((scanned + 1))
      ;;
    *)
      # grep itself failed (unreadable file, bad pattern): the result is unknown, not clean.
      errors=$((errors + 1))
      echo "::error::[audit-no-mocks] grep failed (exit $rc) while scanning: $path"
      printf '%s\n' "$out"
      ;;
  esac
done

echo "[audit-no-mocks] scanned=$scanned core paths, missing=$missing, paths_with_hits=$hits, grep_errors=$errors"

if [ "$hits" -gt 0 ]; then
  echo "[audit-no-mocks] FAIL - remove mocks / stubs / hardcoded responses from the core path (SC-009)."
  exit 1
fi
if [ "$errors" -gt 0 ]; then
  echo "[audit-no-mocks] BLOCKED - grep failed on $errors core path(s); result unknown, not clean."
  exit 4
fi
if [ "$missing" -gt 0 ] && [ "${AUDIT_STRICT:-0}" = "1" ]; then
  echo "[audit-no-mocks] BLOCKED - $missing core path(s) without auditable sources; cannot claim SC-009."
  exit 2
fi
echo "[audit-no-mocks] PASS - no mock / stub / hardcoded-response markers in the scanned core paths."
exit 0
