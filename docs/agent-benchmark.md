# Agent contract: benchmark PandamStyle

## Objective and modes

Choose one mode and label it in the report. PandamStyle has no general
project-benchmark command. Use project scripts and available measurement tools;
do not invent a command or fabricate results.

| Mode | Work performed | Result label |
| --- | --- | --- |
| Quick estimate | Read cheap project descriptors and select comparable qualified reference cells. Execute no build, edit or user workload. | `estimated; no workload executed; not measured` |
| Deep benchmark | Run actual existing-stack and PandamStyle workloads in a controlled, recorded environment. | `measured` with raw runs and environment |

## Quick / estimate mode

This mode MUST NOT run build/dev scripts, install packages, edit files or
execute a synthetic workload. Collect only cheap descriptors already in the
project: host/backend and versions; project/module counts; app-local source
file counts and JS/TS/JSX/TSX distribution; styling files; PandamStyle entity
counts if installed; rough dependency graph size if already available; and
repeated-style/design-system fan-out indicators.

Compare descriptors to the synthetic compiler corpora in the retained
[Alpha 1 reference dataset](../benchmarks/alpha1-reference.json). Match its
corpus and edit labels, then report only the reference cells that apply. Read
the dataset's measurement, environment, and interpretation-limit fields when
describing a match. It is not a validated model for predicting this project's
milliseconds; do not turn corpus size into a speed prediction.

In `referenceRange`, name the exact dataset corpus and edit rows, or state
`none`. This is the measured range represented by those reference cells, never
a predicted latency range for the audited project.

Minimum output:

```yaml
mode: quick-estimate
estimate:
  workloadFit: near | smaller | larger | unknown
  comparableScenarios: []
confidence: high | medium | low
referenceCorpus: ""
referenceRange: ""
measured: false
statement: "No workload was executed; these are project descriptors, not performance measurements."
descriptors: {}
limitations: []
```

If no comparable corpus cell exists, report `unknown` and no performance
estimate. Cite the reference and explain which project traits lower confidence.

## Deep mode prerequisites

Require a supported host/backend, repeatable build/dev commands, a stable
checkout, and an unchanged environment for both sides. Record CPU, OS, Node,
package manager, lockfile, framework/bundler versions, power/thermal conditions
when known, output mode, warm/cold cache policy and all background load. Use
the same fixture and route set for both states. Keep raw samples and command
logs outside generated products or summarize their paths.

Do not rerun historical baselines for a quick estimate. For a new comparison,
measure both the existing stack and PandamStyle version in the same environment
and order or interleave runs to reduce warm-up bias. If the existing stack
cannot execute the semantic edit, mark the cell unavailable rather than
comparing unlike work.

## Stop conditions and forbidden claims

Stop deep mode if the host is not qualified, the workload cannot be repeated,
the baseline/PandamStyle edits do not represent the same work, or environmental
differences prevent a fair comparison. Report unavailable cells instead of
filling them with estimates. Do not call a quick descriptor estimate a
measurement, quote historical c10000 numbers as project predictions, or claim
causation from a single uncontrolled run.

## Deep workload selection

Run only workloads applicable to the audited project:

- Cold dev startup and production build.
- A local style edit.
- A semantic token edit when the project has tokens.
- A theme edit when the project has themes.
- A recipe/slot/compound edit when it has recipes.
- A pattern or patterned-token edit when it has patterns.
- Host-visible update latency for a real route, separately from compiler
  latency, if the project already has an observable browser/host harness.

For each edit, measure from a defined mutation timestamp to compiler settlement
and separately to browser-visible update if available. Record median and every
raw sample; use the same number of warm-up and measured runs on both versions.
Collect CPU time and peak RSS with an available OS/project tool. Record
recompilation, invalidation and design-system probe counters only when the host
or compiler already exposes them. Do not add instrumentation that changes the
compared workload without documenting it.

## Output and comparison rules

Report each result with mode, metric/unit, workload, start/end boundary, number
of samples, summary statistic, raw-data location, baseline and PandamStyle
versions, environment, and unavailable metrics. Separate tool/compiler
latency, full edit-to-settlement, browser-visible latency, CPU and RSS. Label
environment differences and do not merge unlike methods into one percentage.

Use the exact comparison denominator and scenario in any derived percent. A
qualified reference is not a prediction for the audited project. Never
fabricate a missing baseline or present the quick estimate as a measurement.
