#!/usr/bin/env python3
# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.
"""Assemble the Spike 1 evidence and the report tables from raw observations.

This reads what the campaign actually wrote and formats it. It computes no new
statistics: every median, p95 and count comes from summarize.py, so there is one
implementation of the arithmetic in the repository and not two that can disagree.

What it adds is the CROSS-ENGINE TABLE and the phase breakdown, which need the
raw stream and summarize.py's per-group output together.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
# summarize.py sits beside the benchmark root, not beside this script.
SUMMARIZE = HERE.parent / "summarize.py"

REFERENCE = "babel_current"
VARIANT = "babel_work_eliminated"

# The KPI and the sub-intervals that must never be collapsed into it.
KPI = "filesystem_to_diagnostics_ms"
STAGES = [
    "diagnostics_complete_ms",
    "pms_generation_ready_ms",
    "pms_generation_committed_ms",
    "bundler_ready_ms",
]

# Phases reported in the breakdown, in the order a reader should read them.
# `parse_ms` is measured at the parse site, not inferred from a transform
# boundary; `parse_ms:<pipeline>` splits it.
PHASES = [
    "parse_ms",
    "parse_ms:module-graph",
    "parse_ms:babel:pass1",
    "parse_ms:babel:pass2",
    "semantic_ms",
    "ir_lower_ms",
    "policy_ms",
    "recipe_ms",
    "atomic_lower_ms",
    "hash_dedup_ms",
    "rule_sort_ms",
    "css_serialize_ms",
    "css_join_ms",
    "styleq_ms",
    "resolve_ms",
    "io_ms",
    "coverage_graph_ms",
    "ds_build_registry_ms",
    "ds_token_compile_ms",
    "ds_theme_compile_ms",
    "ds_recipe_compile_ms",
    "ds_manifest_ms",
    "ds_module_codegen_ms",
    "publish_ms",
    "boundary_ms",
    "startup_ms",
]

COUNTERS = [
    "parse_calls_total",
    "parse_distinct_files",
    "parse_max_per_file",
    "module_cache_max_lookups_per_file",
    "semantic_builds",
    "pass1_calls",
    "pass2_calls",
    "design_system_builds",
    "ds_module_walks",
    "ds_module_walk_hits",
    "resolution_probes",
    "stat_calls",
    "read_calls",
    "read_bytes",
    "write_calls",
    "written_bytes",
    "atoms",
    "atom_contributions",
    "diagnostics",
    "rss_peak_bytes",
    "heap_peak_bytes",
    "external_peak_bytes",
]

# Phases that are nested inside another phase and must not be summed with it.
NESTED_IN = {
    "parse_ms:module-graph": "parse_ms",
    "parse_ms:babel:pass1": "parse_ms",
    "parse_ms:babel:pass2": "parse_ms",
    "css_join_ms": "css_serialize_ms",
    "styleq_ms": "css_serialize_ms",
    "rule_sort_ms": "css_serialize_ms",
    "atomic_lower_ms": "ir_lower_ms",
}


def read_jsonl(path):
    rows = []
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def run_summarize(observations, out_path):
    subprocess.run(
        [sys.executable, str(SUMMARIZE), "-i", str(observations), "-o", str(out_path)],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    return json.loads(Path(out_path).read_text(encoding="utf-8"))


def stats_for(summary, engine, corpus, scenario, cache_state, metric, run_kind="qualification"):
    for group in summary["summary"]:
        if (
            group["engine"] == engine
            and group["corpus"] == corpus
            and group["scenario"] == scenario
            and group["cache_state"] == cache_state
            and group["metric"] == metric
            and group.get("run_kind") == run_kind
        ):
            return group
    return None


def med(group, key="median"):
    if group is None or group.get("statistics") is None:
        return None
    return group["statistics"].get(key)


def fmt(value, digits=1):
    if value is None:
        return "-"
    if isinstance(value, int):
        return f"{value:,}"
    return f"{value:,.{digits}f}"


def comparison_table(summary, corpus, scenario, cache_state, metric=KPI):
    """The paired current-vs-variant row, with the non-ranking rule applied."""
    a = stats_for(summary, REFERENCE, corpus, scenario, cache_state, metric)
    b = stats_for(summary, VARIANT, corpus, scenario, cache_state, metric)
    if a is None or b is None:
        return None
    a_bad = {k: v for k, v in a["status_counts"].items() if k != "ok"}
    b_bad = {k: v for k, v in b["status_counts"].items() if k != "ok"}
    comparable = not a_bad and not b_bad
    am, bm = med(a), med(b)
    ap, bp = med(a, "p95_upper_rank"), med(b, "p95_upper_rank")
    absolute = relative = None
    p95_absolute = p95_relative = None
    if comparable and am not in (None, 0) and bm is not None:
        absolute = bm - am
        relative = (bm - am) / am * 100.0
    if comparable and ap not in (None, 0) and bp is not None:
        p95_absolute = bp - ap
        p95_relative = (bp - ap) / ap * 100.0
    return {
        "corpus": corpus,
        "scenario": scenario,
        "cache_state": cache_state,
        "metric": metric,
        "comparable": comparable,
        "comparability_note": (
            ""
            if comparable
            else f"correctness/status differs: current={a_bad} variant={b_bad}; NOT ranked"
        ),
        "current_median": am,
        "current_p95": ap,
        "current_n": med(a, "count"),
        "variant_median": bm,
        "variant_p95": bp,
        "variant_n": med(b, "count"),
        "absolute_delta_ms": absolute,
        "relative_delta_pct": relative,
        "p95_absolute_delta_ms": p95_absolute,
        "p95_relative_delta_pct": p95_relative,
        "sessions_current": a["session_count"],
        "sessions_variant": b["session_count"],
    }


def markdown_comparison(rows, title):
    out = [f"### {title}", ""]
    out.append(
        "| scenario | cache state | current median | current p95 | work-elim median | "
        "work-elim p95 | abs Δ | rel Δ | correct |"
    )
    out.append("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |")
    for r in rows:
        if r is None:
            continue
        correct = "yes" if r["comparable"] else "**NO**"
        out.append(
            "| {scenario} | {cache_state} | {am} | {ap} | {bm} | {bp} | {ad} | {rd} | {correct} |".format(
                scenario=r["scenario"],
                cache_state=r["cache_state"],
                am=fmt(r["current_median"]),
                ap=fmt(r["current_p95"]),
                bm=fmt(r["variant_median"]),
                bp=fmt(r["variant_p95"]),
                ad=("-" if r["absolute_delta_ms"] is None else f"{r['absolute_delta_ms']:+,.1f}"),
                rd=("-" if r["relative_delta_pct"] is None else f"{r['relative_delta_pct']:+.1f}%"),
                correct=correct,
            )
        )
    out.append("")
    return out


def phase_table(summary, corpus, scenario, cache_state, run_kind="qualification"):
    total_group = stats_for(summary, REFERENCE, corpus, scenario, cache_state, KPI, run_kind)
    if total_group is None or total_group.get("statistics") is None:
        return None, None
    total = total_group["statistics"]["median"]
    rows = []
    for phase in PHASES:
        a = stats_for(summary, REFERENCE, corpus, scenario, cache_state, phase, run_kind)
        b = stats_for(summary, VARIANT, corpus, scenario, cache_state, phase, run_kind)
        if a is None and b is None:
            continue
        am, bm = med(a), med(b)
        if am is None and bm is None:
            rows.append(
                {
                    "metric": phase,
                    "current": None,
                    "variant": None,
                    "pct_of_total": None,
                    "nested_in": NESTED_IN.get(phase),
                    "unavailable": True,
                }
            )
            continue
        rows.append(
            {
                "metric": phase,
                "current": am,
                "variant": bm,
                "pct_of_total": (am / total * 100.0) if (am is not None and total) else None,
                "nested_in": NESTED_IN.get(phase),
                "unavailable": False,
            }
        )
    return total, rows


def markdown_phase(total, rows, label):
    out = [f"### {label}", ""]
    if total is None:
        out.append("_no successful observation for this cell_")
        out.append("")
        return out
    out.append(f"Total `filesystem_to_diagnostics_ms` median: **{fmt(total)} ms**")
    out.append("")
    out.append("| phase | current median ms | % of total | work-eliminated median ms | notes |")
    out.append("| --- | ---: | ---: | ---: | --- |")
    for r in rows:
        if r["unavailable"]:
            out.append(
                f"| `{r['metric']}` | - | - | - | not isolable; recorded `unsupported` with a reason |"
            )
            continue
        note = ""
        if r["nested_in"]:
            note = f"nested inside `{r['nested_in']}`; not additive with it"
        out.append(
            f"| `{r['metric']}` | {fmt(r['current'], 2)} | {fmt(r['pct_of_total'], 1)}% | {fmt(r['variant'], 2)} | {note} |"
        )
    out.append("")
    return out


def counter_table(summary, corpus, scenario, cache_state, run_kind="qualification"):
    rows = []
    for c in COUNTERS:
        a = stats_for(summary, REFERENCE, corpus, scenario, cache_state, c, run_kind)
        b = stats_for(summary, VARIANT, corpus, scenario, cache_state, c, run_kind)
        if a is None and b is None:
            continue
        rows.append(
            {
                "counter": c,
                "current": med(a),
                "variant": med(b),
            }
        )
    return rows


def number(value):
    """Median or None, formatted for a table cell. A missing group is '-',
    never a zero: a phase that was not measured is not a phase that took no time."""
    return "-" if value is None else fmt(value)


def markdown_counters(rows, label):
    out = [f"### {label}", ""]
    out.append("| counter | current | work-eliminated |")
    out.append("| --- | ---: | ---: |")
    for r in rows:
        out.append(
            f"| `{r['counter']}` | {fmt(r['current'])} | {fmt(r['variant'])} |"
        )
    out.append("")
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--observations", required=True, help="JSONL, or a comma separated list")
    parser.add_argument("--out", required=True, help="where to write the assembled report data")
    parser.add_argument("--markdown", help="where to write the markdown fragment")
    args = parser.parse_args()

    paths = [Path(p) for p in args.observations.split(",")]
    rows = []
    for p in paths:
        rows.extend(read_jsonl(p))
    print(f"read {len(rows):,} observations from {len(paths)} file(s)", file=sys.stderr)

    combined = Path(args.out).with_suffix(".jsonl")
    with open(combined, "w", encoding="utf-8") as handle:
        for r in rows:
            handle.write(json.dumps(r) + "\n")
    summary = run_summarize(combined, Path(args.out).with_suffix(".summary.json"))

    corpora = sorted({r["corpus"] for r in rows})
    scenarios = sorted({r["scenario"] for r in rows})
    cache_states = [
        "process_cold_cache_empty",
        "process_cold_cache_warm",
        "process_warm_no_edit",
        "process_warm_edit",
    ]
    present_states = sorted({r["cache_state"] for r in rows})

    result = {
        "documentKind": "pandamstyle-spike1-report-data",
        "corpora": corpora,
        "scenarios": scenarios,
        "cache_states_present": present_states,
        "comparison": {},
        "phases": {},
        "counters": {},
        "status_counts": {},
    }

    md = ["## Measured comparison", ""]

    for corpus in corpora:
        for scenario in scenarios:
            for cache_state in present_states:
                row = comparison_table(summary, corpus, scenario, cache_state)
                if row is None:
                    continue
                result["comparison"].setdefault(corpus, {})[
                    f"{scenario}|{cache_state}"
                ] = row
        rows_for_corpus = [
            r
            for r in result["comparison"].get(corpus, {}).values()
            if r["metric"] == KPI
        ]
        md.extend(
            markdown_comparison(
                rows_for_corpus, f"{corpus} - primary KPI `{KPI}` (ms)"
            )
        )

    for corpus in corpora:
        for cache_state in present_states:
            for scenario in scenarios:
                total, phase_rows = phase_table(summary, corpus, scenario, cache_state)
                if phase_rows is None:
                    continue
                result["phases"].setdefault(corpus, {})[
                    f"{scenario}|{cache_state}"
                ] = {"total": total, "rows": phase_rows}
            counter_rows = counter_table(summary, corpus, "one_file_new_atom", cache_state)
            if counter_rows:
                result["counters"].setdefault(corpus, {})[cache_state] = counter_rows

    # The phase and counter tables a reader actually needs: the cold build and
    # the primary agentic edit, at the smallest scale.
    smallest = corpora[0] if corpora else None
    for cache_state in ("process_cold_cache_empty", "process_warm_edit"):
        if smallest is None:
            break
        total, phase_rows = phase_table(summary, smallest, "one_file_new_atom", cache_state)
        if phase_rows is not None:
            md.extend(markdown_phase(total, phase_rows, f"{smallest} / one_file_new_atom / {cache_state} - where the time goes"))
        counter_rows = counter_table(summary, smallest, "one_file_new_atom", cache_state)
        if counter_rows:
            md.extend(markdown_counters(counter_rows, f"{smallest} / one_file_new_atom / {cache_state} - counters"))

    for r in rows:
        result["status_counts"][r.get("status")] = result["status_counts"].get(r.get("status"), 0) + 1

    Path(args.out).write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    if args.markdown:
        Path(args.markdown).write_text("\n".join(md), encoding="utf-8")
    print(f"wrote {args.out}", file=sys.stderr)
    if args.markdown:
        print(f"wrote {args.markdown}", file=sys.stderr)


if __name__ == "__main__":
    main()
