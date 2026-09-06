#!/usr/bin/env bash
# scripts/check-workspace-filters.sh - guards against the class of bug in PR #41: a
# workspace package.json's "name" field is renamed (or a package is removed), but a
# `pnpm --filter <name>` / `turbo run ... --filter '<name>'` reference elsewhere in the
# repo (CI, root package.json scripts, shell scripts) still uses the old name and starts
# failing - "No package found with name '<old>' in workspace" - only once that code path
# actually runs (which can be much later than the rename itself).
#
# This is a purely mechanical, deterministic check (no LLM): it collects every workspace
# package's current `name`, then scans committed files for `--filter <token>` references
# (both positive, e.g. `--filter subgraph`, and turbo's negated form, e.g.
# `--filter='!subgraph'`) and flags any token that isn't a current package name.
#
# Known limitations (documented, not solved here - see docs/dev/repo-health-audit.md for
# the broader periodic check that can catch these): it cannot tell a real invocation from
# one that merely appears inside a comment or a markdown code block (false positive risk
# if a doc deliberately shows an old/removed name as a negative example); it does not scan
# specs/*.md or other prose docs (a stale --filter example there won't be caught here -
# quickstart.md's own examples were fixed by hand, see the commit this script shipped in);
# it does not resolve turbo's own additional selector syntax (path filters like
# `./apps/*`, ellipsis `...`) beyond skipping tokens containing `*` or `.`.
#
# Usage: bash scripts/check-workspace-filters.sh
# Exit codes: 0 clean, 1 stale/unknown filter reference found, 2 could not enter repo root,
#             3 collecting package names or scanning files failed (result unknown, not clean).
set -u

cd "$(dirname "$0")/.." || exit 2

# --- collect current workspace package names --------------------------------------------
for required_dir in apps packages; do
  if [ ! -d "$required_dir" ]; then
    echo "::error::[check-workspace-filters] expected directory '$required_dir' not found - scan scope is wrong, refusing to report PASS"
    exit 3
  fi
done

names=()
collect_failed=0
while IFS= read -r -d '' pkg; do
  name=$(node -e "const p=require('node:path').resolve(process.cwd(),process.argv[1]);process.stdout.write(require(p).name || '')" "$pkg")
  rc=$?
  if [ "$rc" -ne 0 ]; then
    collect_failed=1
    echo "::error::[check-workspace-filters] could not read package name from $pkg (node exit $rc)"
    continue
  fi
  [ -n "$name" ] && names+=("$name")
done < <(find apps packages -maxdepth 2 -name package.json -not -path '*/node_modules/*' -print0)

if [ "$collect_failed" -eq 1 ]; then
  echo "[check-workspace-filters] BLOCKED - failed to read one or more package.json names; result unknown, not clean."
  exit 3
fi
if [ "${#names[@]}" -eq 0 ]; then
  echo "::error::[check-workspace-filters] found zero workspace packages - refusing to check anything against an empty list"
  exit 1
fi

is_known_name() {
  local candidate="$1"
  for n in "${names[@]}"; do
    [ "$n" = "$candidate" ] && return 0
  done
  return 1
}

# --- scan files that legitimately contain --filter references -----------------------------
# Asserted rather than trusting `find`'s exit code: if either directory is ever moved/removed,
# a silently-empty scan must not report PASS.
for required_dir in .github/workflows scripts; do
  if [ ! -d "$required_dir" ]; then
    echo "::error::[check-workspace-filters] expected directory '$required_dir' not found - scan scope is wrong, refusing to report PASS"
    exit 3
  fi
done

files=()
while IFS= read -r -d '' f; do
  files+=("$f")
done < <(find .github/workflows scripts -type f \( -name '*.yml' -o -name '*.yaml' -o -name '*.sh' \) -print0)
[ -f package.json ] && files+=("package.json")

# Matches --filter (= or space) then an optional quote (' or ") then an optional turbo
# negation (!) then the package-name token, stopping at the closing quote / whitespace /
# end of line. Handles both `--filter subgraph` and `--filter='!subgraph'` forms; does not
# require `!` (that was a real bug - a first version only matched negated filters and
# silently ignored every positive one, which is the majority form in this repo).
# Char class includes `*` so a turbo glob like `@truenft/*` is captured whole (and then
# recognized as a glob below) instead of being truncated to `@truenft/`, which would
# otherwise look like an unknown, malformed package name.
pattern="--filter[= ]+[\"']?!?[A-Za-z0-9@/_.*-]+"

errors=0
scan_failed=0
for f in "${files[@]}"; do
  [ -f "$f" ] || continue
  # Only look at lines that also mention pnpm/turbo - every real invocation in this repo's
  # corpus does. A line without either word is prose describing the mechanism (a comment,
  # or this script's own header), which would otherwise trip this check on itself.
  # Known limitation: a `pnpm \` / continuation-line invocation whose `--filter` argument
  # is on the *next* line won't be caught (no such pattern exists in this repo today).
  invocation_lines=$(grep -E 'pnpm|turbo' -- "$f")
  grep_rc=$?
  if [ "$grep_rc" -ge 2 ]; then
    scan_failed=1
    echo "::error::[check-workspace-filters] grep failed (exit $grep_rc) while scanning $f for pnpm/turbo lines"
    continue
  fi
  matches=$(printf '%s\n' "$invocation_lines" | grep -oE -- "$pattern")
  rc=$?
  if [ "$rc" -ge 2 ]; then
    scan_failed=1
    echo "::error::[check-workspace-filters] grep failed (exit $rc) while scanning $f"
    continue
  fi
  [ "$rc" -eq 1 ] && continue # no matches in this file, not an error
  while IFS= read -r raw; do
    [ -z "$raw" ] && continue
    token="${raw#--filter}"
    token="${token#=}"
    # strip ALL leading separator characters (multiple spaces are valid shell syntax),
    # not just one - a single `${var# }` only removes one occurrence.
    while [ "${token# }" != "$token" ]; do token="${token# }"; done
    token="${token#\'}"
    token="${token#\"}"
    token="${token#!}" # turbo's exclusion prefix, e.g. --filter='!subgraph'
    [ -z "$token" ] && continue
    case "$token" in
      *'*'*|*'.'*) continue ;; # glob/path/ellipsis selectors (e.g. ./apps/*, ..., @scope/*), not a single package name
    esac
    if ! is_known_name "$token"; then
      errors=$((errors + 1))
      echo "::error::[check-workspace-filters] $f references --filter '$token', which is not a current workspace package name"
    fi
  done <<< "$matches"
done

echo "[check-workspace-filters] known packages: ${names[*]}"
if [ "$scan_failed" -eq 1 ]; then
  echo "[check-workspace-filters] BLOCKED - grep failed on one or more files; result unknown, not clean."
  exit 3
fi
if [ "$errors" -gt 0 ]; then
  echo "[check-workspace-filters] FAIL - $errors stale/unknown --filter reference(s) found."
  exit 1
fi
echo "[check-workspace-filters] PASS - every --filter reference matches a current workspace package."
exit 0
