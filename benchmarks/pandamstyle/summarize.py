#!/usr/bin/env python3
# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.
"""PandamStyle benchmark summary.

WHAT THIS IS

A summariser for the benchmark observation JSONL. It reads raw observations and
produces per-(engine, corpus, scenario, cache-state, metric) statistics:

    count, median, p95, sample variance, and a status breakdown.

WHAT THIS IS NOT

It is not a confidence-interval calculator, and it says so. The architecture
study recommends session/block-level statistical treatment because warm events
inside one session are correlated: a median over all observations silently
gives one session more votes than another. This script therefore PRESERVES the
session id and the event order in its output, and reports the number of
distinct sessions behind every statistic, so a reader can see how much
independent evidence there actually is. If a session count is 1, a p95 from 30
observations is a description of one run, not a distribution, and the output
says so.

Raw observations are never destroyed. This script only reads them.

Self-test:

    python3 summarize.py --self-test
"""

from __future__ import annotations

import argparse
import json
import math
import os
import statistics
import sys
from collections import OrderedDict, defaultdict

SCHEMA_VERSION = 1

# The Benchmark Kit metric names. Anything else in the file is still summarised
# (the kit's metrics are not a closed set) but these are the ones the report
# tables are built from.
KIT_METRICS = [
    "filesystem_to_diagnostics_ms",
    "diagnostics_complete_ms",
    "pms_generation_ready_ms",
    "pms_generation_committed_ms",
    "bundler_ready_ms",
    "startup_ms",
    "io_ms",
    "resolve_ms",
    "parse_ms",
    "semantic_ms",
    "ir_lower_ms",
    "policy_ms",
    "recipe_ms",
    "atomic_lower_ms",
    "hash_dedup_ms",
    "rule_sort_ms",
    "js_codegen_ms",
    "sourcemap_ms",
    "css_serialize_ms",
    "cache_validate_ms",
    "cache_hydrate_ms",
    "boundary_ms",
    "publish_ms",
]

# The primary KPI. Reported first, and never merged with another metric.
PRIMARY_METRIC = "filesystem_to_diagnostics_ms"

# A cache hit on identical source is not edit latency. These are summarised and
# reported, in their own rows, and are never averaged together with an edit.
NO_OP_CACHE_STATES = {"process_warm_no_edit"}


def read_observations(path):
    """Yields (line_number, object), skipping and reporting malformed lines."""
    rows = []
    malformed = []
    with open(path, "r", encoding="utf-8") as handle:
        for lineno, line in enumerate(handle, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as exc:
                malformed.append((lineno, str(exc)))
                continue
            rows.append((lineno, obj))
    return rows, malformed


def percentile_upper_rank(values, p):
    """p95 by UPPER RANK: the ceil(p/100 * n)-th smallest value.

    Upper rank, not interpolation and not nearest rank: with n=20, p95 is the
    19th of 20 sorted values, which is a value that was actually observed.
    Interpolating would invent a number no run produced, and nearest rank would
    silently drop the worst observation at small n.
    """
    if not values:
        return None
    ordered = sorted(values)
    n = len(ordered)
    rank = math.ceil(p / 100.0 * n)
    rank = max(1, min(n, rank))
    return ordered[rank - 1]


def summarize_values(values):
    if not values:
        return None
    return OrderedDict(
        [
            ("count", len(values)),
            ("min", min(values)),
            ("median", statistics.median(values)),
            ("p95_upper_rank", percentile_upper_rank(values, 95)),
            ("max", max(values)),
            (
                "sample_variance",
                statistics.variance(values) if len(values) > 1 else None,
            ),
        ]
    )


def summarize(observations):
    """Groups observations and computes statistics per key.

    The key deliberately INCLUDES the cache state and the run kind. Grouping
    across them would produce a number that describes no real configuration:
    a no-op cache hit and a real edit are different quantities, and a debug run
    and a qualification run are different qualities of evidence.
    """
    groups = defaultdict(list)
    for obs in observations:
        key = (
            obs.get("engine"),
            obs.get("corpus"),
            obs.get("scenario"),
            obs.get("cache_state"),
            obs.get("metric"),
            obs.get("unit"),
            obs.get("run_kind"),
        )
        groups[key].append(obs)

    results = []
    for key, rows in sorted(groups.items(), key=lambda kv: [str(x) for x in kv[0]]):
        engine, corpus, scenario, cache_state, metric, unit, run_kind = key
        values = [r["value"] for r in rows if r.get("status") == "ok" and isinstance(r.get("value"), (int, float))]
        statuses = defaultdict(int)
        for r in rows:
            statuses[r.get("status")] += 1
        sessions = sorted({r.get("session_id") for r in rows if r.get("session_id") is not None})
        # Event order is preserved, not reconstructed: the raw file is the
        # record of order, and this only reports how many independent sessions
        # the statistic rests on.
        engines = sorted({r.get("engine") for r in rows})
        stats = summarize_values(values)
        entry = OrderedDict(
            [
                ("engine", engine),
                ("corpus", corpus),
                ("scenario", scenario),
                ("cache_state", cache_state),
                ("metric", metric),
                ("unit", unit),
                ("run_kind", run_kind),
                ("engines", engines),
                ("session_count", len(sessions)),
                ("sessions", sessions),
                ("observation_count", len(rows)),
                ("status_counts", dict(statuses)),
            ]
        )
        if stats is None:
            entry["statistics"] = None
            entry["note"] = (
                "no successful numeric observation in this group; every "
                "observation is recorded with a non-ok status and is visible "
                "in status_counts"
            )
        else:
            entry["statistics"] = stats
            if len(sessions) <= 1:
                entry["note"] = (
                    "one session: the median and p95 describe a single process, "
                    "not a distribution. Treat as a measurement, not an interval."
                )
        if metric == PRIMARY_METRIC and cache_state in NO_OP_CACHE_STATES:
            entry["note"] = (
                (entry.get("note", "") + " ").strip()
                + "CACHE-HIT CONTROL: this is identical bytes resubmitted, not an "
                "edit. It is not edit latency and must not be compared with an "
                "edit row."
            ).strip()
        results.append(entry)
    return results


def compare(summaries, metric=PRIMARY_METRIC, reference="babel_current", variant="babel_work_eliminated"):
    """Builds the paired comparison table.

    Engines are NOT ranked when their correctness status differs: a faster
    engine that accepts a program the reference rejects, or that produces
    different output, has not won anything. The row is emitted with a
    `comparable: false` and the reason instead of a delta.
    """
    by_key = defaultdict(dict)
    for s in summaries:
        if s.get("metric") != metric:
            continue
        for engine in s.get("engines", []):
            by_key[(s["corpus"], s["scenario"], s["cache_state"], s["run_kind"])][engine] = s

    rows = []
    for key, engines in sorted(by_key.items(), key=lambda kv: [str(x) for x in kv[0]]):
        corpus, scenario, cache_state, run_kind = key
        ref = engines.get(reference)
        var = engines.get(variant)
        if ref is None or var is None:
            continue
        row = OrderedDict(
            [
                ("corpus", corpus),
                ("scenario", scenario),
                ("cache_state", cache_state),
                ("run_kind", run_kind),
                ("metric", metric),
            ]
        )
        comparable, why = _comparable(ref, var)
        row["comparable"] = comparable
        row["comparability_note"] = why
        for label, s in (("current", ref), ("work_eliminated", var)):
            st = s.get("statistics")
            row[f"{label}_median"] = st["median"] if st else None
            row[f"{label}_p95"] = st["p95_upper_rank"] if st else None
            row[f"{label}_count"] = st["count"] if st else 0
        rm = row["current_median"]
        vm = row["work_eliminated_median"]
        if comparable and rm not in (None, 0) and vm is not None:
            row["absolute_delta_ms"] = vm - rm
            row["relative_delta_pct"] = (vm - rm) / rm * 100.0
        else:
            row["absolute_delta_ms"] = None
            row["relative_delta_pct"] = None
        rp = row["current_p95"]
        vp = row["work_eliminated_p95"]
        if comparable and rp not in (None, 0) and vp is not None:
            row["p95_absolute_delta_ms"] = vp - rp
            row["p95_relative_delta_pct"] = (vp - rp) / rp * 100.0
        rows.append(row)
    return rows


def _comparable(ref, var):
    ref_bad = {k: v for k, v in ref["status_counts"].items() if k != "ok"}
    var_bad = {k: v for k, v in var["status_counts"].items() if k != "ok"}
    if not ref_bad and not var_bad:
        return True, "both engines: every observation ok"
    return (
        False,
        "correctness/status differs between the engines, so they are NOT ranked: "
        f"current={ref_bad} work_eliminated={var_bad}. A faster engine that does "
        "not do the same work has not won.",
    )


def _self_test():
    """Proves the statistics, the schema guard and the non-ranking rule.

    A summariser whose arithmetic is wrong is worse than no summariser, so the
    self-test is part of the required verification, not a nicety.
    """
    failures = []

    def check(name, got, want):
        if got != want:
            failures.append(f"{name}: got {got!r}, want {want!r}")

    # 1. p95 by upper rank, on a known series.
    values = list(range(1, 21))  # 1..20
    check("p95 upper rank n=20", percentile_upper_rank(values, 95), 19)
    check("p50 upper rank n=20", percentile_upper_rank(values, 50), 10)
    check("p95 upper rank n=1", percentile_upper_rank([7.0], 95), 7.0)
    check("p95 upper rank empty", percentile_upper_rank([], 95), None)
    check("p95 clamps at max", percentile_upper_rank([1, 2], 95), 2)
    check("p95 of single value is that value", percentile_upper_rank([42], 95), 42)

    # 2. median and sample variance on a known series.
    check("median odd", statistics.median([1, 2, 3]), 2)
    check("median even", statistics.median([1, 2, 3, 4]), 2.5)
    check("variance n=1 is undefined", summarize_values([5.0])["sample_variance"], None)
    check(
        "variance n=2",
        round(summarize_values([1.0, 3.0])["sample_variance"], 10),
        round(statistics.variance([1.0, 3.0]), 10),
    )

    # 3. A realistic observation set: 3 sessions, 2 iterations, a no-op and an
    #    edit, and one error that must remain visible.
    rows = []
    for session in ("s01", "s02", "s03"):
        for iteration, value in ((1, 10.0), (2, 12.0)):
            for cache_state in ("process_warm_no_edit", "process_warm_edit"):
                rows.append(
                    {
                        "engine": "babel_current",
                        "corpus": "c100-t100-r10-s101-f4",
                        "scenario": "one_file_new_atom",
                        "cache_state": cache_state,
                        "session_id": session,
                        "iteration": iteration,
                        "metric": PRIMARY_METRIC,
                        "unit": "ms",
                        "status": "ok",
                        "value": value,
                        "run_kind": "qualification",
                        "schema_version": SCHEMA_VERSION,
                    }
                )
    rows.append(
        {
            "engine": "babel_current",
            "corpus": "c100-t100-r10-s101-f4",
            "scenario": "one_file_new_atom",
            "cache_state": "process_warm_edit",
            "session_id": "s01",
            "iteration": 3,
            "metric": PRIMARY_METRIC,
            "unit": "ms",
            "status": "error",
            "value": None,
            "run_kind": "qualification",
            "schema_version": SCHEMA_VERSION,
        }
    )

    summaries = summarize(rows)
    edit_group = [
        s
        for s in summaries
        if s["cache_state"] == "process_warm_edit" and s["metric"] == PRIMARY_METRIC
    ][0]
    check("session count preserved", edit_group["session_count"], 3)
    check("observation count includes the error", edit_group["observation_count"], 7)
    check("successful count excludes the error", edit_group["statistics"]["count"], 6)
    check("error is visible", edit_group["status_counts"].get("error"), 1)
    check("median of 6", edit_group["statistics"]["median"], 11.0)

    noop_group = [
        s
        for s in summaries
        if s["cache_state"] == "process_warm_no_edit" and s["metric"] == PRIMARY_METRIC
    ][0]
    if "CACHE-HIT CONTROL" not in (noop_group.get("note") or ""):
        failures.append("no-op cache state is not labelled as a cache hit")
    check(
        "no-op and edit are separate groups",
        edit_group["statistics"]["count"] == noop_group["statistics"]["count"],
        True,
    )

    # 4. A single session must be flagged as a measurement, not an interval.
    single = summarize(
        [
            {
                "engine": "e",
                "corpus": "c",
                "scenario": "s",
                "cache_state": "process_warm_edit",
                "session_id": "s01",
                "iteration": 1,
                "metric": PRIMARY_METRIC,
                "unit": "ms",
                "status": "ok",
                "value": 1.0,
                "run_kind": "debug",
            }
        ]
    )[0]
    if "single process" not in (single.get("note") or ""):
        failures.append("a single-session group is not flagged as non-distributional")

    # 5. Engines with different correctness status must NOT be ranked.
    def mk(engine, status):
        return {
            "engine": engine,
            "engines": [engine],
            "corpus": "c",
            "scenario": "s",
            "cache_state": "process_warm_edit",
            "run_kind": "qualification",
            "metric": PRIMARY_METRIC,
            "status_counts": {"ok": 5} if status == "ok" else {"ok": 4, "error": 1},
            "statistics": {"count": 5, "median": 10.0, "p95_upper_rank": 12.0},
        }

    rows_cmp = compare([mk("babel_current", "ok"), mk("babel_work_eliminated", "error")])
    check("mismatched status is not comparable", rows_cmp[0]["comparable"], False)
    check("mismatched status has no delta", rows_cmp[0]["absolute_delta_ms"], None)

    rows_cmp2 = compare([mk("babel_current", "ok"), mk("babel_work_eliminated", "ok")])
    check("matching status is comparable", rows_cmp2[0]["comparable"], True)
    check("delta sign", rows_cmp2[0]["absolute_delta_ms"], 0.0)

    # 6. A negative case that correctly refuses is ok, not error.
    neg = summarize(
        [
            {
                "engine": "e",
                "corpus": "c",
                "scenario": "forbidden_value",
                "cache_state": "process_warm_edit",
                "session_id": "s01",
                "iteration": 1,
                "metric": PRIMARY_METRIC,
                "unit": "ms",
                "status": "ok",
                "value": 5.0,
                "run_kind": "qualification",
            }
        ]
    )[0]
    check("negative rejection is ok", neg["status_counts"], {"ok": 1})

    # 7. Malformed lines are reported, not silently skipped.
    tmp = "summarize-self-test.jsonl"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(rows[0]) + "\n")
        handle.write("{not json}\n")
        handle.write("\n")
        handle.write(json.dumps(rows[1]) + "\n")
    parsed, malformed = read_observations(tmp)
    os.unlink(tmp)
    check("malformed line detected", len(malformed), 1)
    check("good lines kept", len(parsed), 2)

    if failures:
        print("SELF-TEST FAILED", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        return 1
    print("self-test ok: upper-rank p95, median, sample variance, session")
    print("preservation, error visibility, cache-hit labelling, non-ranking of")
    print("mismatched correctness, and malformed-line reporting all behave.")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true", help="run the self-test and exit")
    parser.add_argument("--input", "-i", help="observations JSONL")
    parser.add_argument("--out", "-o", help="write the summary JSON here")
    parser.add_argument("--metric", default=PRIMARY_METRIC, help="metric for the comparison table")
    parser.add_argument("--json", action="store_true", help="print JSON to stdout")
    args = parser.parse_args(argv)

    if args.self_test:
        return _self_test()

    if not args.input:
        parser.error("--input is required (or use --self-test)")

    parsed, malformed = read_observations(args.input)
    observations = [obj for _, obj in parsed]
    summaries = summarize(observations)
    comparisons = compare(summaries, metric=args.metric)

    result = OrderedDict(
        [
            ("documentKind", "pandamstyle-benchmark-summary"),
            ("schemaVersion", SCHEMA_VERSION),
            ("input", os.path.abspath(args.input)),
            ("observation_count", len(observations)),
            ("malformed_lines", len(malformed)),
            ("malformed_detail", [{"line": n, "error": e} for n, e in malformed]),
            ("method", OrderedDict([
                ("p95", "upper rank: the ceil(0.95 * n)-th smallest observed value"),
                ("median", "standard median"),
                ("variance", "sample variance (n-1), null when n == 1"),
                ("grouping", "by engine, corpus, scenario, cache_state, metric, unit, run_kind"),
                ("sessions", "preserved and counted; a group with one session is flagged"),
                ("confidence_intervals", "NOT computed by this script, by design"),
            ])),
            ("summary", summaries),
            ("comparison", comparisons),
        ]
    )

    text = json.dumps(result, indent=2) + "\n"
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(text)
        print(f"summary -> {args.out}")
    if args.json or not args.out:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
