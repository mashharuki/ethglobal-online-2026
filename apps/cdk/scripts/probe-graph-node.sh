#!/bin/bash
# tasks.md T021 - day1 probe for the self-hosted Graph Node (research.md R-5).
#
# Deploys the minimal GraphNodeStack, waits for graph-node to answer, deploys the Rights Graph
# subgraph to it and watches _meta.block.number. Records observations to
# apps/cdk/out/probe-graph-node.json. It costs money (EC2 + EIP): it refuses to run unless
# PROBE_CONFIRM=yes, and ALWAYS prints the teardown command on exit once deploy has started.
#   PROBE_CONFIRM=yes ALLOWED_ADMIN_CIDR=<your ip>/32 bash apps/cdk/scripts/probe-graph-node.sh
# Exit codes: 0 = synced and progressing, 1 = failed / inconclusive (stack still running!), 2 = refused.
set -euo pipefail

if [ "${PROBE_CONFIRM:-}" != "yes" ]; then
  echo "refusing to deploy paid AWS resources: set PROBE_CONFIRM=yes (and ALLOWED_ADMIN_CIDR)" >&2
  exit 2
fi
ADMIN_CIDR="${ALLOWED_ADMIN_CIDR:?set ALLOWED_ADMIN_CIDR=<ip>/32 so graph deploy can reach 8020/5001}"
REGION="${CDK_DEFAULT_REGION:-${AWS_REGION:-ap-northeast-1}}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT_DIR="$ROOT/apps/cdk/out"
mkdir -p "$OUT_DIR"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DEPLOY_STARTED=0

teardown_reminder() {
  local rc=$?
  if [ "$DEPLOY_STARTED" = "1" ]; then
    echo
    echo "REMINDER: GraphNodeStack bills while it runs (exit code $rc). Tear it down with:"
    echo "  pnpm --filter cdk destroy"
  fi
}
trap teardown_reminder EXIT

echo "[1/5] cdk deploy GraphNodeStack (region=$REGION)"
DEPLOY_STARTED=1
(cd "$ROOT/apps/cdk" && pnpm exec cdk deploy GraphNodeStack --require-approval never \
  -c "allowedAdminCidr=$ADMIN_CIDR" --outputs-file "$OUT_DIR/cdk-outputs.json")
EIP="$(jq -r '.GraphNodeStack.ElasticIp' "$OUT_DIR/cdk-outputs.json")"
ADMIN_URL="$(jq -r '.GraphNodeStack.GraphNodeAdminUrl' "$OUT_DIR/cdk-outputs.json")"
IPFS_URL="$(jq -r '.GraphNodeStack.IpfsUrl' "$OUT_DIR/cdk-outputs.json")"
QUERY_URL="$(jq -r '.GraphNodeStack.GraphqlUrl' "$OUT_DIR/cdk-outputs.json")"
echo "EIP=$EIP"

echo "[2/5] waiting for graph-node on http://$EIP:8000 (up to 15 min: image pull + boot)"
READY=false
for _ in $(seq 1 90); do
  if curl -fsS --max-time 5 "http://$EIP:8000/" >/dev/null 2>&1; then READY=true; break; fi
  sleep 10
done
if [ "$READY" != "true" ]; then
  echo "graph-node did not become reachable - inspect with: $(jq -r '.GraphNodeStack.SsmStartSessionCommand' "$OUT_DIR/cdk-outputs.json")" >&2
  exit 1
fi
READY_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "[3/5] graph create + deploy (needs out/296/deployment.json write-back in apps/subgraph/config/testnet.json)"
(cd "$ROOT/apps/subgraph" && GRAPH_NODE_ADMIN="$ADMIN_URL" pnpm run create) || true
(cd "$ROOT/apps/subgraph" && GRAPH_NODE_ADMIN="$ADMIN_URL" GRAPH_NODE_IPFS="$IPFS_URL" pnpm run deploy)

echo "[4/5] polling _meta.block.number for 3 minutes to measure sync progress"
FIRST=""
LAST=""
SAMPLES=0
for _ in $(seq 1 18); do
  BLOCK="$(curl -fsS --max-time 10 "$QUERY_URL" -H 'content-type: application/json' \
    -d '{"query":"{ _meta { block { number } } }"}' | jq -r '.data._meta.block.number // empty' || true)"
  if [[ "$BLOCK" =~ ^[0-9]+$ ]]; then
    [ -z "$FIRST" ] && FIRST="$BLOCK"
    LAST="$BLOCK"
    SAMPLES=$((SAMPLES + 1))
    echo "  block=$BLOCK"
  fi
  sleep 10
done

VERDICT="inconclusive"
RC=1
if [ "$SAMPLES" -eq 0 ]; then
  VERDICT="no _meta answer (subgraph not deployed or graph-node unhealthy)"
elif [ "$LAST" -gt "$FIRST" ]; then
  VERDICT="syncing ($((LAST - FIRST)) blocks in 3 min)"
  RC=0
else
  VERDICT="stalled (block unchanged for 3 min)"
fi

echo "[5/5] recording results: $VERDICT"
jq -n --arg startedAt "$STARTED_AT" --arg readyAt "$READY_AT" --arg eip "$EIP" \
  --arg queryUrl "$QUERY_URL" --arg first "${FIRST:-}" --arg last "${LAST:-}" \
  --argjson samples "$SAMPLES" --arg verdict "$VERDICT" \
  '{startedAt:$startedAt, graphNodeReadyAt:$readyAt, elasticIp:$eip, queryUrl:$queryUrl,
    metaBlockFirst:$first, metaBlockAfter3min:$last, samples:$samples, verdict:$verdict,
    note:"copy into research.md day1 probe table (R-5). Subgraph Studio Hedera support must be re-checked by hand."}' \
  > "$OUT_DIR/probe-graph-node.json"
cat "$OUT_DIR/probe-graph-node.json"
exit "$RC"
