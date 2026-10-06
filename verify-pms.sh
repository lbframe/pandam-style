#!/usr/bin/env bash
# PandamStyle - Phase 5 verification entry point.
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
#   PMS_PILOT_DIR=<path> ./verify-pms.sh # override external pilot scratch
#   PMS_BATCH_BASE_REF=<ref> ./verify-pms.sh
#                                       # override the ref the batch base is
#                                       # derived from (default HEAD)
#   PMS_ONLY_STEPS=a,b ./verify-pms.sh  # run a subset of steps (used by the
#                                       # runner's own test; a partial run is
#                                       # reported as incomplete, never as passed)
#
# Outputs (run directory, default evidence/native/):
#   env.json              toolchain, bases, lockfile, commands
#   run.log               raw console output of every step
#   <step>.log            per-step raw log with its real exit code
#   steps.tsv             per-step name/status/exit code/note
#   summary.json          per-step status + counts, no double counting
#   artifacts/            generated CSS/JS/manifests, digested
#   package-qualification/ packed-package consumer evidence
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

# ---------------------------------------------------- initial git state ---
# The order here is the contract: resolve the repository, capture the Git state,
# and only THEN create the run directory.
#
# Measuring the working tree after `mkdir -p "$PMS_OUT_DIR"` made the runner
# dirty the checkout itself and then report that self-inflicted state as
# evidence: the committed consolidation run recorded `workingTree: "dirty"` on a
# tree that was clean when the run started. Nothing is written before the
# measurement below.
GIT_IN_WORK_TREE=no
if [ "$(git -C "$REPO_ROOT" rev-parse --is-inside-work-tree 2>/dev/null || true)" = "true" ]; then
  GIT_IN_WORK_TREE=yes
fi
# env.json is JSON: the flag is emitted as a JSON boolean, not as a shell word.
if [ "$GIT_IN_WORK_TREE" = "yes" ]; then
  GIT_IN_WORK_TREE_JSON=true
else
  GIT_IN_WORK_TREE_JSON=false
fi

TESTED_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
TESTED_TREE="$(git -C "$REPO_ROOT" rev-parse 'HEAD^{tree}' 2>/dev/null || echo unknown)"
TESTED_BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"

# Reported as found, not as the runner leaves it. A checkout that is genuinely
# dirty before the run still reports dirty; outside a work tree nothing was
# measured, and "clean" would be a claim about a state never observed.
if [ "$GIT_IN_WORK_TREE" = "yes" ]; then
  if [ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]; then
    DIRTY="dirty"
  else
    DIRTY="clean"
  fi
else
  DIRTY="unknown (not a git work tree)"
fi

# The batch base is a Git relation, never a commit count. `rev-parse HEAD~4`
# returned the right SHA only for as long as the batch stayed exactly four
# commits long: committed evidence then resolved to a stale base. The merge
# base with the source branch is a relation, so it does not move when the batch
# grows.
PANDAMSTYLE_BASE_REF="${PMS_BATCH_BASE_REF:-HEAD}"
PANDAMSTYLE_BASE_RESOLVED=""
for base_candidate in "$PANDAMSTYLE_BASE_REF" "refs/remotes/origin/$PANDAMSTYLE_BASE_REF"; do
  if git -C "$REPO_ROOT" rev-parse --verify --quiet "$base_candidate^{commit}" >/dev/null 2>&1; then
    PANDAMSTYLE_BASE_RESOLVED="$base_candidate"
    break
  fi
done
if [ -z "$PANDAMSTYLE_BASE_RESOLVED" ]; then
  echo "Cannot verify the PandamStyle batch base: ref '$PANDAMSTYLE_BASE_REF' does not exist in $REPO_ROOT." >&2
  echo "Set PMS_BATCH_BASE_REF to the branch this batch was started from." >&2
  echo "Refusing to report a batch base that is not a verified Git relation." >&2
  exit 2
fi
PANDAMSTYLE_BASE="$(git -C "$REPO_ROOT" merge-base HEAD "$PANDAMSTYLE_BASE_RESOLVED" 2>/dev/null || true)"
if [ -z "$PANDAMSTYLE_BASE" ]; then
  echo "HEAD and '$PANDAMSTYLE_BASE_RESOLVED' share no common ancestor: the batch base is undefined." >&2
  echo "Refusing to report a batch base that is not a verified Git relation." >&2
  exit 2
fi

# ------------------------------------------------------------------- output ---
PMS_OUT_DIR="${PMS_OUT_DIR:-$REPO_ROOT/evidence/native}"
PMS_PILOT_DIR="${PMS_PILOT_DIR:-/tmp/pandamstyle-pilot-${TESTED_COMMIT}-$$}"

# Refuse to write outside the repository: an accidental escape would make the
# evidence untraceable. Checked before any directory is created, and again on
# the canonical path below.
refuse_outside_repo() {
  case "$1" in
    "$REPO_ROOT"/*) ;;
    *)
      echo "PMS_OUT_DIR must stay inside the repository ($REPO_ROOT)." >&2
      echo "Refusing to write to: $1" >&2
      exit 2
      ;;
  esac
}
refuse_outside_repo "$PMS_OUT_DIR"

mkdir -p "$PMS_OUT_DIR"
PMS_OUT_DIR="$(cd "$PMS_OUT_DIR" && pwd)"
refuse_outside_repo "$PMS_OUT_DIR"
export PMS_OUT_DIR
LOG_DIR="$PMS_OUT_DIR"
ARTIFACT_DIR="$PMS_OUT_DIR/artifacts"
mkdir -p "$ARTIFACT_DIR"

RUN_LOG="$LOG_DIR/run.log"
: > "$RUN_LOG"
# A bootstrap/parser failure must never leave an earlier green summary in place.
rm -f "$LOG_DIR/summary.json"

STEP_NAMES=()
STEP_STATUS=()
STEP_CODES=()
STEP_NOTES=()

# The three statuses a step can have. A step that was never executed is `skipped`,
# NOT `passed`: recording an exit code 0 for a step that did not run is how a
# partial run becomes indistinguishable from a complete one.
STATUS_PASSED=passed
STATUS_FAILED=failed
STATUS_SKIPPED=skipped

# Optional step filter (comma separated). Used by the runner's own test so the
# script can be exercised without paying for a full install/build/suite/pilot run.
ONLY_STEPS="${PMS_ONLY_STEPS:-}"
SELECTED_STEPS=""
if [ -n "$ONLY_STEPS" ]; then
  IFS=',' read -r -a _sel <<< "$ONLY_STEPS"
  for s in "${_sel[@]}"; do
    SELECTED_STEPS="$SELECTED_STEPS $(printf '%s' "$s" | tr -d '[:space:]')"
  done
fi

log() { printf '%s\n' "$*" | tee -a "$RUN_LOG"; }
logq() { printf '%s\n' "$*" >> "$RUN_LOG"; }

# should_run <step-name>
should_run() {
  [ -z "$SELECTED_STEPS" ] && return 0
  case " $SELECTED_STEPS " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

# is_filtered_out <step-name> - true when the step is neither selected nor a
# phase the runner must always perform (env capture, summary).
is_filtered_out() {
  case "$1" in
    env|summary) return 1 ;;
  esac
  ! should_run "$1"
}

record_step() {
  # record_step <name> <exit-code> [note]
  STEP_NAMES+=("$1")
  STEP_CODES+=("$2")
  if [ "$2" -eq 0 ]; then
    STEP_STATUS+=("$STATUS_PASSED")
  else
    STEP_STATUS+=("$STATUS_FAILED")
  fi
  STEP_NOTES+=("${3:-}")
}

record_skip() {
  # record_skip <name> <note>
  STEP_NAMES+=("$1")
  STEP_CODES+=("-")
  STEP_STATUS+=("$STATUS_SKIPPED")
  STEP_NOTES+=("$2")
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

# A step that is deliberately not executed. It gets no log and no exit code,
# because inventing either would misreport the run.
skip_step() {
  local name="$1"
  local note="$2"
  log "== $name (skipped: $note)"
  record_skip "$name" "$note"
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
  YARN_MAJOR="${YARN_VERSION%%.*}"
  if [ "$YARN_MAJOR" != "1" ]; then
    log "yarn 1 is required (found $YARN_VERSION)."
    exit 2
  fi
else
  log "yarn 1 is required (the repository lockfile is yarn.lock)."
  exit 2
fi

# The Git state was captured above, before the run directory existed.

# ------------------------------------------------------------------- env.json ---
cat > "$PMS_OUT_DIR/env.json" <<EOF
{
  "documentKind": "pandamstyle-run-environment",
  "testedCommit": "$TESTED_COMMIT",
  "testedTree": "$TESTED_TREE",
  "testedBranch": "$TESTED_BRANCH",
  "workingTree": "$DIRTY",
  "gitWorkTree": $GIT_IN_WORK_TREE_JSON,
  "pandamstyleBatchBaseRef": "$PANDAMSTYLE_BASE_RESOLVED",
  "pandamstyleBatchBase": "$PANDAMSTYLE_BASE",
  "outDir": "$PMS_OUT_DIR",
  "pilotDir": "$PMS_PILOT_DIR",
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
log "  branch         : $TESTED_BRANCH"
log "  working tree   : $DIRTY (as found, before this run wrote anything)"
log "  batch base ref : $PANDAMSTYLE_BASE_RESOLVED"
log "  batch base     : $PANDAMSTYLE_BASE"
log "  out dir        : $PMS_OUT_DIR"
log ""

# ------------------------------------------------------------------- 1. install ---
# A targeted install is explicit: it runs the dependency install and then builds
# exactly the packages this repository owns and ships.
if [ "${PMS_SKIP_INSTALL:-0}" = "1" ]; then
  skip_step "install" "PMS_SKIP_INSTALL=1"
elif is_filtered_out "install"; then
  skip_step "install" "not selected by PMS_ONLY_STEPS"
else
  run_step "install" env \
    NODE_OPTIONS="" \
    yarn install --frozen-lockfile --non-interactive
fi

# --------------------------------------------------------------------- 2. build ---
build_delivered_packages() (
  set -e
  # The delivered PandamStyle-owned compiler, built by its own Rollup config.
  (cd "$REPO_ROOT/packages/compiler" \
    && "$REPO_ROOT/node_modules/.bin/rollup" --config ./rollup.config.mjs)
  # The Vite adapter ships its authored ESM entry directly and depends only on
  # the public compiler package surface.
  node --check "$REPO_ROOT/packages/vite/src/index.js"
  node -e 'const p = require(process.argv[1]); if (p.exports?.["."]?.import !== "./src/index.js" || p.peerDependencies?.vite !== "8.3.1") process.exit(1)' \
    "$REPO_ROOT/packages/vite/package.json"
  node --check "$REPO_ROOT/packages/rsbuild/src/index.js"
  node -e 'const p = require(process.argv[1]); if (p.exports?.["."]?.import !== "./src/index.js" || p.peerDependencies?.["@rsbuild/core"] !== "2.2.11") process.exit(1)' \
    "$REPO_ROOT/packages/rsbuild/package.json"
)

if is_filtered_out "build"; then
  skip_step "build" "not selected by PMS_ONLY_STEPS"
else
  run_step "build" build_delivered_packages
fi

# -------------------------------------------------------------------- 3. suites ---
if is_filtered_out "pandamstyle"; then
  skip_step "pandamstyle" "not selected by PMS_ONLY_STEPS"
else
  run_step "pandamstyle" \
    "$REPO_ROOT/node_modules/.bin/jest" --config "$REPO_ROOT/jest.config.js" \
      --ci --runInBand \
      "$REPO_ROOT/packages/compiler/__tests__/pandamstyle" \
      "$REPO_ROOT/packages/compiler/__tests__/engine-absorption-test.js"
fi

if is_filtered_out "pandamstyle-core"; then
  skip_step "pandamstyle-core" "not selected by PMS_ONLY_STEPS"
else
  run_step "pandamstyle-core" \
    "$REPO_ROOT/node_modules/.bin/jest" --config "$REPO_ROOT/jest.config.js" \
    --ci --runInBand --runTestsByPath "$REPO_ROOT/packages/core/__tests__/core-test.js"
fi

# The semantic oracle reconciles a tracked explicit suite/case inventory with
# filesystem, Jest discovery and actual execution. It cannot bless expectations.
if is_filtered_out "semantic-oracle"; then
  skip_step "semantic-oracle" "not selected by PMS_ONLY_STEPS"
else
  run_step "semantic-oracle" node "$REPO_ROOT/tools/semantic-oracle/run.js" "$PMS_OUT_DIR/semantic-oracle"
fi

# Tooling verification independently reconciles tracked suites and discovery.
if is_filtered_out "tooling-tests"; then
  skip_step "tooling-tests" "not selected by PMS_ONLY_STEPS"
else
  run_step "tooling-tests" node "$REPO_ROOT/tools/pms/run-tooling-tests.js" "$PMS_OUT_DIR"
fi

# --------------------------------------------------------------------- 8. pilot ---
if [ "${PMS_SKIP_PILOT:-0}" = "1" ]; then
  skip_step "pilot" "PMS_SKIP_PILOT=1"
elif is_filtered_out "pilot"; then
  skip_step "pilot" "not selected by PMS_ONLY_STEPS"
else
  run_step "pilot" bash "$REPO_ROOT/tools/pilot/run-pilot.sh" "$PMS_PILOT_DIR"
fi

# ---------------------------------------------------------------- 9. artifacts ---
collect_artifacts() (
  set -e
  rm -rf "$ARTIFACT_DIR"
  mkdir -p "$ARTIFACT_DIR"
  # The compiled package the pilot installed.
  cp -R "$REPO_ROOT/packages/compiler/lib" "$ARTIFACT_DIR/compiler-lib"
  cp "$REPO_ROOT/packages/compiler/package.json" \
     "$ARTIFACT_DIR/compiler-package.json"
  cp -R "$REPO_ROOT/packages/core/src" "$ARTIFACT_DIR/core-src"
  cp "$REPO_ROOT/packages/core/package.json" "$ARTIFACT_DIR/core-package.json"
  mkdir -p "$ARTIFACT_DIR/vite-adapter"
  cp -R "$REPO_ROOT/packages/vite/src" "$ARTIFACT_DIR/vite-adapter/src"
  cp -R "$REPO_ROOT/packages/vite/types" "$ARTIFACT_DIR/vite-adapter/types"
  cp "$REPO_ROOT/packages/vite/package.json" \
     "$ARTIFACT_DIR/vite-adapter/package.json"
  node "$REPO_ROOT/tools/pms/core-package-proof.js" \
    "$PMS_OUT_DIR/core-package-proof"
  cp -R "$PMS_OUT_DIR/core-package-proof" "$ARTIFACT_DIR/core-package-proof"
  # One valid fixture build, for the complete canonical artifact set.
  (cd "$REPO_ROOT/packages/compiler/__tests__/pandamstyle/fixtures/valid" \
    && node "$REPO_ROOT/packages/compiler/bin/pms-build.js" \
       --config ./pandamstyle.config.js)
  cp -R "$REPO_ROOT/packages/compiler/__tests__/pandamstyle/fixtures/valid/generated" \
     "$ARTIFACT_DIR/valid-fixture-generation"
  node "$REPO_ROOT/tools/pms/generated-runtime-imports.js" \
    "$ARTIFACT_DIR/valid-fixture-generation" \
    "$ARTIFACT_DIR/generated-runtime-imports.json"
  if [ -d "$PMS_PILOT_DIR/app/dist" ]; then
    cp -R "$PMS_PILOT_DIR/app/dist" "$ARTIFACT_DIR/pilot-dist"
  fi
  if [ -f "$PMS_PILOT_DIR/pilot-report.json" ]; then
    cp "$PMS_PILOT_DIR/pilot-report.json" "$ARTIFACT_DIR/pilot-report.json"
  fi
  if [ -f "$PMS_PILOT_DIR/pilot-node24-report.json" ]; then
    cp "$PMS_PILOT_DIR/pilot-node24-report.json" "$ARTIFACT_DIR/pilot-node24-report.json"
  fi
  if [ -d "$PMS_PILOT_DIR/app-node24/dist" ]; then
    cp -R "$PMS_PILOT_DIR/app-node24/dist" "$ARTIFACT_DIR/pilot-node24-dist"
  fi
  for proof in package-proof.json external-install-proof.json; do
    if [ -f "$PMS_PILOT_DIR/$proof" ]; then
      cp "$PMS_PILOT_DIR/$proof" "$ARTIFACT_DIR/$proof"
    fi
  done
  if [ -d "$PMS_PILOT_DIR/.tarballs" ]; then
    cp -R "$PMS_PILOT_DIR/.tarballs" "$ARTIFACT_DIR/pilot-tarballs"
  fi
  (cd "$ARTIFACT_DIR" && find . -type f ! -name digests.txt -print0 \
    | sort -z | xargs -0 shasum -a 256 > digests.txt)
)

if is_filtered_out "artifacts"; then
  skip_step "artifacts" "not selected by PMS_ONLY_STEPS"
else
  run_step "artifacts" collect_artifacts
fi

# Donor closure is a separate structural gate. It reads the tarballs installed
# by the pilot and the generated runtime copied by the artifact step.
if is_filtered_out "donor-closure"; then
  skip_step "donor-closure" "not selected by PMS_ONLY_STEPS"
else
  run_step "donor-closure" node "$REPO_ROOT/tools/pms/donor-closure.js" \
    "$REPO_ROOT" \
    "$PMS_PILOT_DIR" \
    "$ARTIFACT_DIR/valid-fixture-generation" \
    "$PMS_OUT_DIR/donor-closure/report.json"
fi

# The public packages must pass an isolated npm-tarball consumer check. Its
# report is the step's deliverable and is required by the evidence contract.
qualify_public_packages() (
  set -e
  node "$REPO_ROOT/tools/pms/package-qualification.js" "$PMS_OUT_DIR/package-qualification"
  # A successful command must qualify each public package, including Vite.
  node - "$PMS_OUT_DIR/package-qualification/report.json" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const file = process.argv[2];
// Absence is reported by the artifact contract in the summary.
if (!fs.existsSync(file)) process.exit(0);
const report = JSON.parse(fs.readFileSync(file, 'utf8'));
assert.equal(report.pass, true);
assert.deepEqual(Object.keys(report.packages).sort(), [
  '@pandamstyle/compiler', '@pandamstyle/core', '@pandamstyle/next', '@pandamstyle/rsbuild', '@pandamstyle/vite',
]);
for (const item of Object.values(report.packages)) {
  assert.equal(item.tarballContents, 'passed');
  assert.equal(item.reproducibility.contentDigestsStable, true);
}
assert.equal(report.externalConsumer.vite.pass, true);
assert.equal(report.externalConsumer.next.pass, true);
assert.equal(report.externalConsumer.typeScript.viteOptions, 'passed');
assert.equal(report.externalConsumer.rsbuild.pass, true);
assert.equal(report.externalConsumer.typeScript.rsbuildOptions, 'passed');
assert.equal(report.externalConsumer.typeScript.nextOptions, 'passed');
assert.equal(report.externalConsumer.checkpoint.pass, true);
NODE
)

if is_filtered_out "package-qualification"; then
  skip_step "package-qualification" "not selected by PMS_ONLY_STEPS"
else
  run_step "package-qualification" qualify_public_packages
fi

qualify_rsbuild() (
  set -e
  node "$REPO_ROOT/tools/pilot/run-rsbuild-qualification.js" "$PMS_OUT_DIR/rsbuild-qualification"
  node - "$PMS_OUT_DIR/rsbuild-qualification/report.json" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
if (!fs.existsSync(process.argv[2])) process.exit(0);
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
assert.equal(report.complete, true);
assert.equal(report.start.dev.pass, true);
assert.equal(report.start.production.pass, true);
assert.equal(report.isolation.pass, true);
assert.equal(report.failures.every(row => row.pass), true);
assert.equal(report.bundleScan.pass, true);
NODE
)
qualify_next() (
  set -e
  node "$REPO_ROOT/tools/pms/qualify-next.mjs" "$PMS_OUT_DIR/next-qualification"
  node - "$PMS_OUT_DIR/next-qualification/report.json" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
assert.equal(report.pass, true);
assert.equal(report.phase10Complete, true, 'Phase 10 remains open: TURBOPACK-DEV-SETTLEMENT');
NODE
)
if is_filtered_out "next-qualification"; then
  skip_step "next-qualification" "not selected by PMS_ONLY_STEPS"
else
  run_step "next-qualification" qualify_next
fi

if is_filtered_out "rsbuild-qualification"; then
  skip_step "rsbuild-qualification" "not selected by PMS_ONLY_STEPS"
else
  run_step "rsbuild-qualification" qualify_rsbuild
fi

# --------------------------------------------------------------------- summary ---
# The step table is written by the shell, so every status below is the real
# observed exit code of that step, or `skipped` when the step never ran.
: > "$PMS_OUT_DIR/steps.tsv"
for i in "${!STEP_NAMES[@]}"; do
  printf '%s\t%s\t%s\t%s\n' \
    "${STEP_NAMES[$i]}" "${STEP_STATUS[$i]}" "${STEP_CODES[$i]}" "${STEP_NOTES[$i]}" \
    >> "$PMS_OUT_DIR/steps.tsv"
done

# --------------------------------------------------- runner sources present ---
# The summary block below reads the runner's own JavaScript from `tools/pms/`.
# Checked here, with a message that names what is missing, rather than discovered
# as a thrown require four steps later: the symptom without this check is a run
# whose steps all passed and whose `summary.json` does not exist, and the reader
# is left guessing between "the runner is broken" and "the summary said
# something". It is derived from the script's own text for the same reason the
# test fixture derives its copies - a second list is a second place to forget.
RUNNER_SOURCES="$(node -e '
  const fs = require("fs");
  const text = fs.readFileSync(process.argv[1], "utf8");
  process.stdout.write(
    [...new Set([...text.matchAll(/tools\/pms\/([\w.-]+\.js)/g)].map((m) => m[1]))].join("\n"),
  );
' "$REPO_ROOT/verify-pms.sh")"
MISSING_SOURCES=""
for _src in $RUNNER_SOURCES; do
  if [ ! -f "$REPO_ROOT/tools/pms/$_src" ]; then
    MISSING_SOURCES="${MISSING_SOURCES} tools/pms/$_src"
  fi
done
if [ -n "$MISSING_SOURCES" ]; then
  log "The runner's own sources are missing from the checkout:${MISSING_SOURCES}"
  log "These are read by the summary block to judge the run. Refusing to write"
  log "a summary without them: no summary is better than an invented one."
  exit 2
fi

if ! node - "$PMS_OUT_DIR" "$TESTED_COMMIT" "$TESTED_TREE" "$DIRTY" "$PANDAMSTYLE_BASE_RESOLVED" "$PANDAMSTYLE_BASE" "$REPO_ROOT" <<'NODE' 2> >(tee -a "$RUN_LOG" >&2)
const fs = require('fs');
const path = require('path');
const out = process.argv[2];
const [commit, tree, dirty, baseRef, base, repoRoot] = process.argv.slice(3);
const env = JSON.parse(fs.readFileSync(path.join(out, 'env.json'), 'utf8'));

const rows = fs
  .readFileSync(path.join(out, 'steps.tsv'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => l.split('\t'));

// The counting and the verdict live in `tools/pms/test-counts.js`, with their
// own tests, because the defect this replaces was a REPORTING defect: the old
// parser read only `passed` and `total`, so a suite that failed to load
// contributed no tests, the total still looked plausible, and a delivery could
// quote a green number for a run that had not run the code. A parser with that
// much authority over the verdict needs its own test suite rather than being
// inlined in a heredoc.
//
// WHICH EVIDENCE A STEP OWES THE RUN lives in `tools/pms/step-contracts.js`,
// for the reason its header sets out: requiring Jest counts of `install` made
// `complete: true` unreachable for any normal run, and a verdict that can never
// be `verified` is not a verdict.
const {
  assessRun,
  parseJestCounts,
} = require(path.join(repoRoot, 'tools/pms/test-counts.js'));
const {
  STEP_CONTRACTS,
  assessStep,
  contractFor,
  evidenceFor,
} = require(path.join(repoRoot, 'tools/pms/step-contracts.js'));

// A missing row is missing required work, even if every recorded row passed.
// Keep the required population in the same table as its evidence contracts.
const requiredStepOrder = Object.keys(STEP_CONTRACTS);
const omittedRequiredSteps = [];
for (const name of requiredStepOrder) {
  if (!rows.some(([recorded]) => recorded === name)) {
    omittedRequiredSteps.push(name);
    rows.push([name, 'skipped', '-', 'required step omitted from step table']);
  }
}

const steps = {};
const skipped = [];
const integrity = [];
let failed = 0;
for (const [name, status, code, note] of rows) {
  const logPath = path.join(out, `${name}.log`);
  // Counts are read ONLY for steps whose contract requires them. Parsing a
  // build log for `Tests:` would let a package whose output happens to contain
  // the word contribute numbers to a delivery's totals that nobody ran.
  const contract = contractFor(name);
  const requiresCounts = evidenceFor(contract?.kind)?.requiresCounts === true;
  let counts = null;
  if (requiresCounts && fs.existsSync(logPath)) {
    counts = parseJestCounts(fs.readFileSync(logPath, 'utf8'));
  }
  if (status === 'skipped') skipped.push(name);
  if (status === 'failed') failed++;
  // A step with no exit code records null, never 0. Reporting 0 is what
  // previously made an unexecuted step indistinguishable from a passing one.
  const exitCode = code === '-' ? null : Number(code);
  // The acceptance vocabulary, mapped explicitly rather than by coincidence.
  const acceptance =
    status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : 'not_run';
  const verdict = assessStep({
    step: name,
    status,
    exitCode,
    counts,
    evidence: {
      // The acceptance vocabulary is RECORDED on the step, not cross-checked
      // here: `record_step` derives `status` from the exit code, so `acceptance`
      // is the same fact as `exitCode === 0` and a check between them cannot
      // fire. What catches a swallowed exit code is a test step's counts -
      // `EXIT_CODE_DISAGREES` - and only a test step has counts to disagree.
      artifactPresent:
        contract?.kind === 'artifact-check'
          ? fs.existsSync(
              path.join(out, contract.artifact ?? 'artifacts/digests.txt'),
            ) &&
            fs.statSync(
              path.join(out, contract.artifact ?? 'artifacts/digests.txt'),
            ).size > 0
          : undefined,
      artifactPath:
        contract?.kind === 'artifact-check'
          ? path.join(out, contract.artifact ?? 'artifacts/digests.txt')
          : undefined,
    },
  });
  integrity.push(verdict);
  steps[name] = {
    kind: contract?.kind ?? null,
    status,
    exitCode,
    acceptance,
    note: note === '' ? null : note,
    // Six numbers, not three: tests and suites, each passed/failed/skipped.
    // A reader who is handed only a passed-test total can be misled by a suite
    // that contributed none, which is exactly how this defect happened.
    //
    // `null` for a step that runs no tests. That is a fact about the step, not a
    // gap in the report, and it is deliberately not `0` - a fabricated zero
    // would enter every total above as a real measurement.
    counts: verdict.counts == null ? null : { ...verdict.counts },
    // The step's own verdict, which can disagree with its status. A step that
    // the shell recorded as passed because the wrapper swallowed the exit code
    // is reported here as failed, and the disagreement is the finding.
    verification: verdict,
  };
}
const runIntegrity = assessRun(integrity);

const summary = {
  documentKind: 'pandamstyle-run-summary',
  testedCommit: commit,
  testedTree: tree,
  workingTree: dirty,
  // The base and the ref it was derived from travel together: a SHA without the
  // relation that produced it is not re-checkable by a reader.
  pandamstyleBatchBaseRef: baseRef,
  pandamstyleBatchBase: base,
  requiredStepCount: requiredStepOrder.length,
  requiredStepOrder,
  omittedRequiredSteps,
  outDir: out,
  toolchain: env.toolchain,
  // A run with a skipped step is NOT a complete run. This flag exists so a
  // consumer of summary.json cannot read a partial run as a full one.
  //
  // `complete` is a conjunction of three SEPARATE claims, and a reader who
  // wants to know which one is false can look. A step can be reported as
  // `complete: false` because it never ran, because a suite failed to load, or
  // because the exit codes and the counts disagree - and those are different
  // defects with different fixes.
  //
  // It is not, and never was, a claim about ONE rule applied to every step. The
  // previous form of this line also required `assessRun` to have verified every
  // step against the Jest-count rule, which `install` and `build` can never
  // satisfy: so `complete: true` was unreachable for any run of this script, and
  // the flag that was supposed to be quotable was not. Each step is now
  // assessed against the evidence its own kind owes - see
  // `tools/pms/step-contracts.js` - and this conjunction is about the RUN.
  complete: skipped.length === 0 && failed === 0 && runIntegrity.verdict === 'verified',
  // The six numbers a delivery has to quote, and the verdict they imply. They
  // are at the TOP of the document because they are what gets quoted, and a
  // number that can be quoted without its verdict is the defect.
  verification: runIntegrity,
  // Every finding that kept a step from being verified, under one key. The name
  // says what it is: these are step-level integrity findings, and calling them
  // `suiteIntegrityFailures` described four steps that run no suites at all.
  stepIntegrityFindings: integrity
    .filter((s) => s.verdict !== 'verified')
    .flatMap((s) => s.findings.map((f) => ({ step: s.step, kind: s.kind, ...f }))),
  // Kept under the old name so a reader of the previous format finds the same
  // content. Two names for one array is a cost; a silent rename is worse.
  suiteIntegrityFailures: integrity
    .filter((s) => s.verdict !== 'verified')
    .flatMap((s) => s.findings.map((f) => ({ step: s.step, ...f }))),
  skippedSteps: skipped,
  failedSteps: Object.keys(steps).filter((n) => steps[n].status === 'failed'),
  steps,
};
fs.writeFileSync(
  path.join(out, 'summary.json'),
  JSON.stringify(summary, null, 2) + '\n',
);
console.log('summary written');
NODE
then
  log "VERIFICATION FAILED: the summary could not be assessed; raw logs and steps.tsv are preserved."
  exit 1
fi

FAILED_STEPS=0
SKIPPED_STEPS=0
for i in "${!STEP_NAMES[@]}"; do
  if [ "${STEP_STATUS[$i]}" = "$STATUS_FAILED" ]; then
    FAILED_STEPS=$((FAILED_STEPS + 1))
  elif [ "${STEP_STATUS[$i]}" = "$STATUS_SKIPPED" ]; then
    SKIPPED_STEPS=$((SKIPPED_STEPS + 1))
  fi
  log "step ${STEP_NAMES[$i]}: ${STEP_STATUS[$i]} (exit ${STEP_CODES[$i]}) ${STEP_NOTES[$i]}"
done

log ""
log "run directory: $PMS_OUT_DIR"

# ONE SOURCE OF TRUTH FOR THE VERDICT.
#
# The shell used to print VERIFICATION OK whenever no step failed and none was
# skipped, while `summary.json` could say `incomplete` about the same run - which
# is the same defect in a second place, and the reason this run reported a green
# result and an incomplete one simultaneously. The document is the authority: it
# holds every step's contract, its evidence and its findings, and this is a
# reader of it rather than a second implementation of the same question.
SUMMARY_COMPLETE=""
RUN_VERDICT=""
if [ -f "$PMS_OUT_DIR/summary.json" ]; then
  read -r SUMMARY_COMPLETE RUN_VERDICT <<EOF
$(node -e '
  const fs = require("fs");
  try {
    const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(`${d.complete === true} ${d.verification?.verdict ?? "unknown"}`);
  } catch {
    // A summary that cannot be read is not a verified run, and saying so here is
    // better than letting a missing document read as a green one.
    process.stdout.write("false unreadable");
  }
' "$PMS_OUT_DIR/summary.json")
EOF
fi

log "tests:  $(node -e '
  const fs = require("fs");
  const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(`${d.verification.testsPassed} passed, ${d.verification.testsFailed} failed, ${d.verification.testsSkipped} skipped`);
' "$PMS_OUT_DIR/summary.json" 2>/dev/null || echo "unavailable")"
log "suites: $(node -e '
  const fs = require("fs");
  const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(`${d.verification.suitesPassed} passed, ${d.verification.suitesFailed} failed, ${d.verification.suitesSkipped} skipped`);
' "$PMS_OUT_DIR/summary.json" 2>/dev/null || echo "unavailable")"
log "verification verdict: ${RUN_VERDICT:-unknown}"
if [ "$SUMMARY_COMPLETE" = "true" ]; then
  for i in "${!STEP_NAMES[@]}"; do
    kind="$(node -e '
      const fs = require("fs");
      const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(d.steps[process.argv[2]]?.kind ?? "unknown");
    ' "$PMS_OUT_DIR/summary.json" "${STEP_NAMES[$i]}" 2>/dev/null || echo unknown)"
    log "  ${STEP_NAMES[$i]}: ${STEP_STATUS[$i]}, ${kind}, verified"
  done
else
  node -e '
    const fs = require("fs");
    const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const f of d.stepIntegrityFindings ?? []) {
      process.stdout.write(`  - [${f.step}${f.kind ? `/${f.kind}` : ""}] ${f.code}: ${f.message}\n`);
    }
  ' "$PMS_OUT_DIR/summary.json" 2>/dev/null || true
fi

if [ "$FAILED_STEPS" -ne 0 ]; then
  log "VERIFICATION FAILED: $FAILED_STEPS required step(s) did not pass."
  exit 1
fi
# A step the shell recorded as passed can still be a failure on its own counts:
# a suite that failed to load exits non-zero, and a wrapper that swallows the
# code would otherwise turn that into a green delivery. The counts are the
# authority, so the run is failed when the counts say it is - whatever the step
# table says.
if [ "$RUN_VERDICT" = "failed" ]; then
  log "VERIFICATION FAILED: a step did not satisfy its verification contract."
  exit 1
fi
if [ "$SUMMARY_COMPLETE" = "true" ]; then
  log "VERIFICATION OK"
  exit 0
fi

# Exit 0 is honest here: nothing that ran failed. The INCOMPLETE verdict is what
# matters, and it is what prevents a partial run from being read as a complete
# P0 verification.
if [ "$SKIPPED_STEPS" -ne 0 ]; then
  log "VERIFICATION INCOMPLETE: $SKIPPED_STEPS step(s) were not run."
  log "This run is NOT a complete verification. The skipped steps were:"
  for i in "${!STEP_NAMES[@]}"; do
    if [ "${STEP_STATUS[$i]}" = "$STATUS_SKIPPED" ]; then
      log "  - ${STEP_NAMES[$i]}: ${STEP_NOTES[$i]}"
    fi
  done
  exit 0
fi
log "VERIFICATION INCOMPLETE: every step ran, but at least one could not be verified."
log "This run is NOT a complete verification."
exit 1
