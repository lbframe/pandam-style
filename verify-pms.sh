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
#   PMS_BATCH_BASE_REF=<ref> ./verify-pms.sh
#                                       # override the ref the batch base is
#                                       # derived from (default
#                                       # feat/pandamstyle-native-compiler)
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
# commits long: the committed evidence was generated when it resolved to
# 38b2e459 instead of the real base. The merge base with the source branch is a
# relation, so it does not move when the batch grows.
PANDAMSTYLE_BASE_REF="${PMS_BATCH_BASE_REF:-feat/pandamstyle-native-compiler}"
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
LOG_DIR="$PMS_OUT_DIR"
ARTIFACT_DIR="$PMS_OUT_DIR/artifacts"
mkdir -p "$ARTIFACT_DIR"

RUN_LOG="$LOG_DIR/run.log"
: > "$RUN_LOG"

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
else
  log "yarn 1 is required (the repository lockfile is yarn.lock)."
  exit 2
fi

# The Git state was captured above, before the run directory existed.
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
  "gitWorkTree": $GIT_IN_WORK_TREE_JSON,
  "pandamstyleBatchBaseRef": "$PANDAMSTYLE_BASE_RESOLVED",
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
log "  branch         : $TESTED_BRANCH"
log "  working tree   : $DIRTY (as found, before this run wrote anything)"
log "  batch base ref : $PANDAMSTYLE_BASE_RESOLVED"
log "  batch base     : $PANDAMSTYLE_BASE"
log "  out dir        : $PMS_OUT_DIR"
log ""

# ------------------------------------------------------------------- 1. install ---
# A targeted install is explicit: it runs the dependency install and then builds
# exactly the packages this delivery ships. It is NOT presented as a successful
# upstream full build; the upstream suite results are reported separately below.
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

if is_filtered_out "build"; then
  skip_step "build" "not selected by PMS_ONLY_STEPS"
else
  run_step "build" build_delivered_packages
fi

# -------------------------------------------------------------------- 3. suites ---
# Upstream reference suites and the PandamStyle suites are separate steps so the
# two results are never conflated or double counted.
if is_filtered_out "upstream-babel-plugin"; then
  skip_step "upstream-babel-plugin" "not selected by PMS_ONLY_STEPS"
else
  run_step "upstream-babel-plugin" \
    bash -c "cd '$REPO_ROOT/packages/@stylexjs/babel-plugin' && '$REPO_ROOT/node_modules/.bin/jest' --ci --testPathIgnorePatterns '/__tests__/pandamstyle/'"
fi
if is_filtered_out "upstream-stylex"; then
  skip_step "upstream-stylex" "not selected by PMS_ONLY_STEPS"
else
  run_step "upstream-stylex" \
    bash -c "cd '$REPO_ROOT/packages/@stylexjs/stylex' && '$REPO_ROOT/node_modules/.bin/cross-env' BABEL_ENV=test '$REPO_ROOT/node_modules/.bin/jest' --ci"
fi
if is_filtered_out "pandamstyle"; then
  skip_step "pandamstyle" "not selected by PMS_ONLY_STEPS"
else
  run_step "pandamstyle" \
    bash -c "cd '$REPO_ROOT/packages/@stylexjs/babel-plugin' && '$REPO_ROOT/node_modules/.bin/jest' --ci '__tests__/pandamstyle/.*-test.js'"
fi

# --------------------------------------------------------------------- 4. pilot ---
if [ "${PMS_SKIP_PILOT:-0}" = "1" ]; then
  skip_step "pilot" "PMS_SKIP_PILOT=1"
elif is_filtered_out "pilot"; then
  skip_step "pilot" "not selected by PMS_ONLY_STEPS"
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

if is_filtered_out "artifacts"; then
  skip_step "artifacts" "not selected by PMS_ONLY_STEPS"
else
  run_step "artifacts" collect_artifacts
fi

# ------------------------------------------------------------------ 6. summary ---
# The step table is written by the shell, so every status below is the real
# observed exit code of that step, or `skipped` when the step never ran.
: > "$PMS_OUT_DIR/steps.tsv"
for i in "${!STEP_NAMES[@]}"; do
  printf '%s\t%s\t%s\t%s\n' \
    "${STEP_NAMES[$i]}" "${STEP_STATUS[$i]}" "${STEP_CODES[$i]}" "${STEP_NOTES[$i]}" \
    >> "$PMS_OUT_DIR/steps.tsv"
done

node - "$PMS_OUT_DIR" "$TESTED_COMMIT" "$TESTED_TREE" "$DIRTY" "$PANDAMSTYLE_BASE_RESOLVED" "$PANDAMSTYLE_BASE" "$REPO_ROOT" <<'NODE'
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
const {
  assessRun,
  assessSuiteIntegrity,
  parseJestCounts,
} = require(path.join(repoRoot, 'tools/pms/test-counts.js'));

const steps = {};
const skipped = [];
const integrity = [];
let failed = 0;
for (const [name, status, code, note] of rows) {
  const logPath = path.join(out, `${name}.log`);
  let counts = null;
  if (fs.existsSync(logPath)) {
    counts = parseJestCounts(fs.readFileSync(logPath, 'utf8'));
  }
  if (status === 'skipped') skipped.push(name);
  if (status === 'failed') failed++;
  // A step with no exit code records null, never 0. Reporting 0 is what
  // previously made an unexecuted step indistinguishable from a passing one.
  const exitCode = code === '-' ? null : Number(code);
  const verdict =
    status === 'skipped'
      ? { step: name, verdict: 'unverified', exitCode: null,
          findings: [{ code: 'STEP_SKIPPED',
            message: `${name}: the step did not run, so nothing about it is verified` }],
          counts: null }
      : assessSuiteIntegrity({ step: name, exitCode, counts });
  integrity.push(verdict);
  steps[name] = {
    status,
    exitCode,
    // The acceptance vocabulary, mapped explicitly rather than by coincidence.
    acceptance:
      status === 'passed'
        ? 'passed'
        : status === 'failed'
          ? 'failed'
          : 'not_run',
    note: note === '' ? null : note,
    // Six numbers, not three: tests and suites, each passed/failed/skipped.
    // A reader who is handed only a passed-test total can be misled by a suite
    // that contributed none, which is exactly how this defect happened.
    counts: counts == null
      ? null
      : {
          testsPassed: counts.testsPassed,
          testsFailed: counts.testsFailed,
          testsSkipped: counts.testsSkipped,
          testsTotal: counts.testsTotal,
          suitesPassed: counts.suitesPassed,
          suitesFailed: counts.suitesFailed,
          suitesSkipped: counts.suitesSkipped,
          suitesTotal: counts.suitesTotal,
          testsAccountedFor: counts.testsAccountedFor,
          suitesAccountedFor: counts.suitesAccountedFor,
        },
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
  outDir: out,
  toolchain: env.toolchain,
  // A run with a skipped step is NOT a complete run. This flag exists so a
  // consumer of summary.json cannot read a partial run as a full one.
  // `complete` is a conjunction of three SEPARATE claims, and a reader who
  // wants to know which one is false can look. A step can be reported as
  // `complete: false` because it never ran, because a suite failed to load, or
  // because the exit codes and the counts disagree - and those are different
  // defects with different fixes.
  complete: skipped.length === 0 && failed === 0 && runIntegrity.verdict === 'verified',
  // The six numbers a delivery has to quote, and the verdict they imply. They
  // are at the TOP of the document because they are what gets quoted, and a
  // number that can be quoted without its verdict is the defect.
  verification: runIntegrity,
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
if [ -f "$PMS_OUT_DIR/suite-integrity.json" ]; then
  node -e '
    const fs = require("fs");
    const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    log "tests:  ${d.verification.testsPassed} passed, ${d.verification.testsFailed} failed, ${d.verification.testsSkipped} skipped";
    log "suites: ${d.verification.suitesPassed} passed, ${d.verification.suitesFailed} failed, ${d.verification.suitesSkipped} skipped";
    log "suite-integrity verdict: ${d.verification.verdict}";
    for (const f of d.suiteIntegrityFailures) {
      log "  - [${f.step}] ${f.code}: ${f.message}";
    }
  ' "$PMS_OUT_DIR/summary.json"
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
SUITE_INTEGRITY_FAILED=0
if [ -f "$PMS_OUT_DIR/summary.json" ]; then
  SUITE_INTEGRITY_FAILED="$(node -e '
    const fs = require("fs");
    try {
      const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(d.verification?.verdict === "failed" ? "1" : "0");
    } catch {
      process.stdout.write("1");
    }
  ' "$PMS_OUT_DIR/summary.json")"
fi
if [ "$SUITE_INTEGRITY_FAILED" -ne 0 ]; then
  log "VERIFICATION FAILED: a test step reported failing tests or suites."
  exit 1
fi
if [ "$SKIPPED_STEPS" -ne 0 ]; then
  # Exit 0 is honest here: nothing that ran failed. The INCOMPLETE verdict is
  # what matters, and it is what prevents a partial run from being read as a
  # complete P0 verification.
  log "VERIFICATION INCOMPLETE: $SKIPPED_STEPS step(s) were not run."
  log "This run is NOT a complete verification. The skipped steps were:"
  for i in "${!STEP_NAMES[@]}"; do
    if [ "${STEP_STATUS[$i]}" = "$STATUS_SKIPPED" ]; then
      log "  - ${STEP_NAMES[$i]}: ${STEP_NOTES[$i]}"
    fi
  done
  exit 0
fi
log "VERIFICATION OK"
