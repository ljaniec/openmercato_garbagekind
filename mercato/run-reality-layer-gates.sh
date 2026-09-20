#!/usr/bin/env bash
# Reality Layer on-site gate runner.
# Run with: bash mercato/run-reality-layer-gates.sh
# Never resets/cleans the checkout and never exits the caller shell when invoked with bash.

set -u
set -o pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SOURCE_ROOT="$(cd "$HERE/.." && pwd)"
MERCATO_ROOT="${MERCATO_ROOT:-/home/ljaniec/Repositories/open-mercato}"
BASE_URL="${BASE_URL:-http://localhost:3000}"
LOG_DIR="${REALITY_GATE_LOG_DIR:-/tmp/reality-layer-gates}"
mkdir -p "$LOG_DIR"

fail() { echo "FAIL: $*" >&2; exit 1; }

run_step() {
  local name="$1"; shift
  echo; echo "================================================================"; echo "START $name"; echo "================================================================"
  "$@" 2>&1 | tee "$LOG_DIR/$name.log"
  local rc=${PIPESTATUS[0]}
  printf "%s\n" "$rc" > "$LOG_DIR/$name.exit"
  echo "EXIT $name = $rc"
  if (( rc != 0 )); then tail -n 120 "$LOG_DIR/$name.log"; exit "$rc"; fi
}

[[ -d "$MERCATO_ROOT/apps/mercato" ]] || fail "Open Mercato clone not found: $MERCATO_ROOT"
echo "Reality Layer source: $SOURCE_ROOT"
echo "Open Mercato root:    $MERCATO_ROOT"
echo "Base URL:             $BASE_URL"
echo "Logs:                 $LOG_DIR"

(
  cd "$MERCATO_ROOT" || exit 1
  printf "branch: "; git branch --show-current
  printf "head:   "; git rev-parse HEAD
  printf "node:   "; node --version
  printf "yarn:   "; corepack yarn --version
  git status --short
) | tee "$LOG_DIR/00-environment.log"

run_step 01-install env MERCATO_ROOT="$MERCATO_ROOT" "$HERE/install.sh" reality_layer
run_step 02-build-packages bash -lc "cd \"$MERCATO_ROOT\" && corepack yarn build:packages"
run_step 03-generate bash -lc "cd \"$MERCATO_ROOT\" && corepack yarn generate"
run_step 04-db-migrate bash -lc "cd \"$MERCATO_ROOT\" && corepack yarn mercato db migrate"
run_step 05-acl-sync bash -lc "cd \"$MERCATO_ROOT\" && corepack yarn mercato auth sync-role-acls"

GEN_DIR="$MERCATO_ROOT/apps/mercato/.mercato/generated"
[[ -d "$GEN_DIR" ]] || fail "Generated registry directory missing: $GEN_DIR"
if grep -R -n --fixed-strings "reality-layer:execution" "$GEN_DIR" > "$LOG_DIR/06-worker-discovery.log" 2>&1; then
  cat "$LOG_DIR/06-worker-discovery.log"
  echo "PASS: reality-layer:execution found in generated registry."
else
  grep -R -n --fixed-strings "reality-layer-execution.worker" "$GEN_DIR" > "$LOG_DIR/06-worker-discovery.log" 2>&1 || true
  cat "$LOG_DIR/06-worker-discovery.log"
  fail "Reality Layer worker was not found in generated registries."
fi

run_step 07-build-packages-after-generate bash -lc "cd \"$MERCATO_ROOT\" && corepack yarn build:packages"
run_step 08-typecheck bash -lc "cd \"$MERCATO_ROOT\" && corepack yarn workspace @open-mercato/app typecheck"
run_step 09-unit-tests bash -lc "cd \"$MERCATO_ROOT/apps/mercato\" && corepack yarn test --testPathPatterns modules/reality_layer"
run_step 10-webpack-build bash -lc "cd \"$MERCATO_ROOT/apps/mercato\" && NODE_OPTIONS=--max-old-space-size=8192 corepack yarn exec next build --webpack"

echo; echo "STATIC/BUILD GATES PASSED"

if [[ "${RUN_REALITY_E2E:-0}" != "1" ]]; then
  echo "E2E not requested. Start the stack and rerun with RUN_REALITY_E2E=1."
  exit 0
fi

curl -fsS --max-time 5 "$BASE_URL" >/dev/null 2>&1 || fail "App is not reachable at $BASE_URL"
run_step 11-e2e bash -lc "cd \"$MERCATO_ROOT\" && OM_INTEGRATION_MODULES=reality_layer BASE_URL=\"$BASE_URL\" corepack yarn exec playwright test --config .ai/qa/tests/playwright.config.ts --grep TC-REALITY"
echo; echo "G1-G10 AUTOMATABLE GATES PASSED"; echo "Logs: $LOG_DIR"
