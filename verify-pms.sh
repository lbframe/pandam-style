#!/usr/bin/env bash
# PandamStyle - verification entry point for the native compilation batch.
#
# Every step propagates its failure. There is no `|| true`, no output filtering
# and no partial success: if a required step fails, this script exits non-zero
# and the run directory records where it stopped.
#
# Usage:
#   ./verify-pms.sh                     # full run (install, build, suites, pilot)
#   PMS_SKIP_INSTALL=1 ./verify-pms.sh  # reuse an existing node_modules (dev only)
#   PMS_SKIP_PILOT=1 ./verify-pms.sh    # skip the Vite pilot
#   PMS_OUT_DIR=<path> ./verify-pms.sh  # override the run directory
#
# Outputs (run directory, default evidence/native/):
#   env.json              toolchain, bases, lockfile, commands
#   run.log               raw console output of every step
#   <step>.log            per-step raw log with its real exit code
#   summary.json          per-step status + counts, no double counting
#   artifacts/            generated CSS/JS/manifests, digested
set -euo pipefail

# ---------------------------------------------------------------- identity ---
# The Git root is resolved through Git itself, never by climbing a fixed number
# of parent directories: a fragile walk is what produced the historical
# `forkCommit: null` defect.
resolve_repo_root() {
  local dir="$1"
  local root
  root="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$root" ] && [ -d "$root" ]; then
    printf '%s\n' "$root"
    return 0
  fi
  # Not a Git work tree: fall back to the directory holding this script.
  printf '%s\n' "$dir"
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(resolve_repo_root "${SCRIPT_DIR}")"
cd "$REPO_ROOT"

# ------------------------------------------------------------------- output ---
PMS_OUT_DIR="${PMS_OUT_DIR:-$REPO_ROOT/evidence/native}"
mkdir -p "$PMS_OUT_DIR"
PMS_OUT_DIR="$(cd "$PMS_OUT_DIR" && pwd)"
LOG_DIR="$PMS_OUT_DIR"
ARTIFACT_DIR="$PMS_OUT_DIR/artifacts"
mkdir -p "$ARTIFACT_DIR"

# Refuse to write outside the repository: an accidental escape would make the
# evidence untraceable.
case "$PMS_OUT_DIR" in
  "$REPO_ROOT"/*) ;;
  *)
    echo "PMS_OUT_DIR must stay inside the repository ($REPO_ROOT)." >&2
    echo "Refusing to write to: $PMS_OUT_DIR" >&2
    exit 2
    ;;
esac

RUN_LOG="$LOG_DIR/run.log"
: > "$RUN_LOG"

STEP_NAMES=()
STEP_STATUS=()
STEP_CODES=()
STEP_NOTES=()

log() { printf '%s\n' "$*" | tee -a "$RUN_LOG"; }
logq() { printf '%s\n' "$*" >> "$RUN_LOG"; }

record_step() {
  # record_step <name> <exit-code> [note]
  STEP_NAMES+=("$1")
  STEP_CODES+=("$2")
  if [ "$2" -eq 0 ]; then
    STEP_STATUS+=("passed")
  else
    STEP_STATUS+=("failed")
  fi
  STEP_NOTES+=("${3:-}")
}

# run_step <name> <command...>
run_step() {
  local name="$1"
  shift
  local step_log="$LOG_DIR/${name}.log"
  log "== $name =="
  logq "\$ $*"
  set +e
  "$@" > "$step_log" 2>&1
  local code=$?
  set -e
  cat "$step_log" >> "$RUN_LOG"
  if [ "$code" -ne 0 ]; then
    log "   FAILED (exit $code) - see ${step_log}"
  else
    log "   ok (exit 0)"
  fi
  record_step "$name" "$code"
  return 0
}

# ----------------------------------------------------------------- toolchain ---
node_major() { node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1; }

REQUIRED_NODE_MAJOR=20
NODE_MAJOR="$(node_major || echo 0)"
if [ "$NODE_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ]; then
  log "Node >= ${REQUIRED_NODE_MAJOR} is required (found $(node -v 2>/dev/null || echo none))."
  log "The repository .nvmrc pins the supported major."
  exit 2
fi

if command -v yarn >/dev/null 2>&1; then
  YARN_VERSION="$(yarn --version 2>/dev/null || echo unknown)"
else
  log "yarn 1 is required (the repository lockfile is yarn.lock)."
  exit 2
fi

TESTED_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
TESTED_TREE="$(git -C "$REPO_ROOT" rev-parse 'HEAD^{tree}' 2>/dev/null || echo unknown)"
TESTED_BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
if [ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]; then
  DIRTY="dirty"
else
  DIRTY="clean"
fi
PANDAMSTYLE_BASE="$(git -C "$REPO_ROOT" rev-parse HEAD~4 2>/dev/null || echo unknown)"
# The fork base is the merge base with the real StyleX upstream, not a string
# copied out of a document.
STYLEX_FORK_BASE="$(git -C "$REPO_ROOT" merge-base HEAD upstream/main 2>/dev/null || echo unknown)"
# The vendored Panda donor is a source copy in this checkout, with no Git
# metadata: report that honestly instead of inheriting an unrelated SHA.
if [ -e "$REPO_ROOT/upstream/panda/.git" ]; then
  PANDA_DONOR_SHA="$(git -C "$REPO_ROOT/upstream/panda" rev-parse HEAD 2>/dev/null || echo unknown)"
else
  PANDA_DONOR_SHA="no-git-metadata-in-this-checkout (pinned SHA recorded in docs/pandamstyle-specification-v0.1/specs/01-ARCHITECTURE.md)"
fi

# ------------------------------------------------------------------- env.json ---
cat > "$PMS_OUT_DIR/env.json" <<EOF
{
  "documentKind": "pandamstyle-run-environment",
  "testedCommit": "$TESTED_COMMIT",
  "testedTree": "$TESTED_TREE",
  "testedBranch": "$TESTED_BRANCH",
  "workingTree": "$DIRTY",
  "pandamstyleBatchBase": "$PANDAMSTYLE_BASE",
  "stylexUpstreamMergeBase": "$STYLEX_FORK_BASE",
  "pandaDonorCommit": "$PANDA_DONOR_SHA",
  "outDir": "$PMS_OUT_DIR",
  "toolchain": {
    "node": "$(node -v)",
    "yarn": "$YARN_VERSION",
    "npm": "$(npm --version 2>/dev/null || echo unknown)"
  },
  "lockfile": "yarn.lock",
  "lockfileSha256": "$(shasum -a 256 "$REPO_ROOT/yarn.lock" 2>/dev/null | cut -d' ' -f1 || echo unknown)"
}
EOF

log "PandamStyle native verification"
log "  repo root      : $REPO_ROOT"
log "  tested commit  : $TESTED_COMMIT"
log "  tested tree    : $TESTED_TREE"
log "  branch         : $TESTED_BRANCH ($DIRTY)"
log "  out dir        : $PMS_OUT_DIR"
log ""

# ------------------------------------------------------------------- 1. install ---
# A targeted install is explicit: it runs the dependency install and then builds
# exactly the packages this delivery ships. It is NOT presented as a successful
# upstream full build; the upstream suite results are reported separately below.
if [ "${PMS_SKIP_INSTALL:-0}" = "1" ]; then
  log "== install (skipped: PMS_SKIP_INSTALL=1) =="
  record_step "install" 0 "skipped by PMS_SKIP_INSTALL=1"
else
  run_step "install" env \
    NODE_OPTIONS="" \
    yarn install --frozen-lockfile --non-interactive
fi

# --------------------------------------------------------------------- 2. build ---
build_delivered_packages() {
  set -e
  (cd "$REPO_ROOT/packages/style-value-parser" \
    && "$REPO_ROOT/node_modules/.bin/babel" src --out-dir lib \
       --ignore "**/__tests__/**","**/__benchmarks__/**")
  (cd "$REPO_ROOT/packages/@stylexjs/shared" \
    && "$REPO_ROOT/node_modules/.bin/babel" src/ --out-dir lib/)
  (cd "$REPO_ROOT/packages/@stylexjs/stylex" \
    && "$REPO_ROOT/node_modules/.bin/cross-env" BABEL_ENV=cjs \
       "$REPO_ROOT/node_modules/.bin/rollup" -c ./rollup.config.mjs \
    && "$REPO_ROOT/node_modules/.bin/cross-env" BABEL_ENV=esm \
       "$REPO_ROOT/node_modules/.bin/rollup" -c ./rollup.config.mjs)
  (cd "$REPO_ROOT/packages/@stylexjs/babel-plugin" \
    && "$REPO_ROOT/node_modules/.bin/rollup" --config ./rollup.config.mjs)
  # The delivered PandamStyle package: the fork engine plus the PandamStyle
  # modules, built by its own rollup config.
  (cd "$REPO_ROOT/packages/@pandamstyle/compiler" \
    && "$REPO_ROOT/node_modules/.bin/rollup" --config ./rollup.config.mjs)
}

run_step "build" build_delivered_packages

# -------------------------------------------------------------------- 3. suites ---
# Upstream reference suites and the PandamStyle suites are separate steps so the
# two results are never conflated or double counted.
run_step "upstream-babel-plugin" \
  bash -c "cd '$REPO_ROOT/packages/@stylexjs/babel-plugin' && '$REPO_ROOT/node_modules/.bin/jest' --ci --testPathIgnorePatterns '/__tests__/pandamstyle/'"
run_step "upstream-stylex" \
  bash -c "cd '$REPO_ROOT/packages/@stylexjs/stylex' && '$REPO_ROOT/node_modules/.bin/cross-env' BABEL_ENV=test '$REPO_ROOT/node_modules/.bin/jest' --ci"
run_step "pandamstyle" \
  bash -c "cd '$REPO_ROOT/packages/@stylexjs/babel-plugin' && '$REPO_ROOT/node_modules/.bin/jest' --ci '__tests__/pandamstyle/.*-test.js'"

# --------------------------------------------------------------------- 4. pilot ---
if [ "${PMS_SKIP_PILOT:-0}" = "1" ]; then
  log "== pilot (skipped: PMS_SKIP_PILOT=1) =="
  record_step "pilot" 0 "skipped by PMS_SKIP_PILOT=1"
else
  run_step "pilot" bash "$REPO_ROOT/tools/pilot/run-pilot.sh" "${PMS_PILOT_DIR:-$PMS_OUT_DIR/pilot}"
fi

# ---------------------------------------------------------------- 5. artifacts ---
collect_artifacts() {
  set -e
  rm -rf "$ARTIFACT_DIR"
  mkdir -p "$ARTIFACT_DIR"
  # The compiled package the pilot installed.
  cp -R "$REPO_ROOT/packages/@pandamstyle/compiler/lib" "$ARTIFACT_DIR/compiler-lib"
  cp "$REPO_ROOT/packages/@pandamstyle/compiler/package.json" \
     "$ARTIFACT_DIR/compiler-package.json"
  # One valid fixture build, for the CSS/JS/manifest triple.
  (cd "$REPO_ROOT/packages/@stylexjs/babel-plugin/__tests__/pandamstyle/fixtures/valid" \
    && node "$REPO_ROOT/packages/@pandamstyle/compiler/bin/pms-build.js" \
       --config ./pandamstyle.config.js)
  cp -R "$REPO_ROOT/packages/@stylexjs/babel-plugin/__tests__/pandamstyle/fixtures/valid/generated" \
     "$ARTIFACT_DIR/valid-fixture-generation"
  if [ -d "${PMS_PILOT_DIR:-$PMS_OUT_DIR/pilot}/app/dist" ]; then
    cp -R "${PMS_PILOT_DIR:-$PMS_OUT_DIR/pilot}/app/dist" "$ARTIFACT_DIR/pilot-dist"
  fi
  (cd "$ARTIFACT_DIR" && find . -type f ! -name digests.txt -print0 \
    | sort -z | xargs -0 shasum -a 256 > digests.txt)
}

run_step "artifacts" collect_artifacts

# ------------------------------------------------------------------ 6. summary ---
# The step table is written by the shell, so every status below is the real
# observed exit code of that step, not a heuristic over log text.
: > "$PMS_OUT_DIR/steps.tsv"
for i in "${!STEP_NAMES[@]}"; do
  printf '%s\t%s\t%s\t%s\n' \
    "${STEP_NAMES[$i]}" "${STEP_STATUS[$i]}" "${STEP_CODES[$i]}" "${STEP_NOTES[$i]}" \
    >> "$PMS_OUT_DIR/steps.tsv"
done

node - "$PMS_OUT_DIR" "$TESTED_COMMIT" "$TESTED_TREE" "$DIRTY" <<'NODE'
const fs = require('fs');
const path = require('path');
const out = process.argv[2];
const [commit, tree, dirty] = process.argv.slice(3);
const env = JSON.parse(fs.readFileSync(path.join(out, 'env.json'), 'utf8'));

const rows = fs
  .readFileSync(path.join(out, 'steps.tsv'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => l.split('\t'));

// Jest prints, e.g.: "Tests: 1 skipped, 46 passed, 47 of 48 total"
function count(text, label) {
  const re = new RegExp(label + ':\\s+(.*)');
  const m = text.match(re);
  if (m == null) return null;
  const tail = m[1];
  const passed = tail.match(/(\d+) passed/);
  const total = tail.match(/(?:of )?(\d+) total/);
  const skipped = tail.match(/(\d+) skipped/);
  return {
    passed: passed ? Number(passed[1]) : null,
    total: total ? Number(total[1]) : null,
    skipped: skipped ? Number(skipped[1]) : null,
  };
}

const steps = {};
for (const [name, status, code, note] of rows) {
  const logPath = path.join(out, `${name}.log`);
  let counts = null;
  if (fs.existsSync(logPath)) {
    const text = fs.readFileSync(logPath, 'utf8');
    const tests = count(text, 'Tests');
    const suites = count(text, 'Test Suites');
    if (tests != null || suites != null) counts = { tests, suites };
  }
  steps[name] = {
    status,
    exitCode: Number(code),
    note: note === '' ? null : note,
    counts,
  };
}

const summary = {
  documentKind: 'pandamstyle-run-summary',
  testedCommit: commit,
  testedTree: tree,
  workingTree: dirty,
  outDir: out,
  toolchain: env.toolchain,
  steps,
};
fs.writeFileSync(
  path.join(out, 'summary.json'),
  JSON.stringify(summary, null, 2) + '\n',
);
console.log('summary written');
NODE

FAILED_STEPS=0
for i in "${!STEP_NAMES[@]}"; do
  if [ "${STEP_STATUS[$i]}" != "passed" ]; then
    FAILED_STEPS=$((FAILED_STEPS + 1))
  fi
  log "step ${STEP_NAMES[$i]}: ${STEP_STATUS[$i]} (exit ${STEP_CODES[$i]}) ${STEP_NOTES[$i]}"
done

log ""
log "run directory: $PMS_OUT_DIR"
if [ "$FAILED_STEPS" -ne 0 ]; then
  log "VERIFICATION FAILED: $FAILED_STEPS required step(s) did not pass."
  exit 1
fi
log "VERIFICATION OK"
