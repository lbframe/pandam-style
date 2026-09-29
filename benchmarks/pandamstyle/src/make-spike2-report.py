#!/usr/bin/env python3
# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.
"""Assemble the Spike 2 evidence tables from the raw observation streams.

It computes no statistics. Every median, p95 and count comes from
`summarize.py`, so there is ONE implementation of the arithmetic in the
repository and not two that can disagree.

What it adds is the cross-engine table, the reuse-counter table and the phase
breakdown, which need the raw stream and summarize.py's per-group output
together, and the correctness verdicts, which come from the oracles and are
never inferred from a latency number.

Usage:
    python3 src/make-spike2-report.py \
        --c1000 /path/c1000.jsonl --c10000 /path/c10000.jsonl \
        --oracle /path/incremental-differential.json \
        --long-session /path/long-session.json \
        --out-dir ../.pms-bench/spike2
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SUMMARIZE = HERE.parent / "summarize.py"

# The engine pair the Spike 2 decision rests on. Both run the SAME tree; the
# only difference between them is which public API of the same bundle is
# driven, so the difference cannot be a tree difference.
REFERENCE = "babel_full"
VARIANT = "babel_incremental"

KPI = "filesystem_to_diagnostics_ms"

STAGES = [
    "diagnostics_complete_ms",
    "pms_generation_ready_ms",
    "pms_generation_committed_ms",
]

# Session phases, in the order a reader should read them.
PHASES = [
    "session_scan_ms",
    "io_ms",
    "session_resolve_ms",
    "session_closure_ms",
    "session_dsv_view_ms",
    "session_compile_files_ms",
    "session_aggregate_ms",
    "css_serialize_ms",
    "publish_ms",
    "boundary_ms",
    "ds_module_codegen_ms",
    "startup_ms",
    "parse_ms",
    "parse_ms:module-graph",
    "parse_ms:babel:pass1",
    "parse_ms:babel:pass2",
    "semantic_ms",
    "ir_lower_ms",
    "policy_ms",
    "atomic_lower_ms",
    "resolve_ms",
    "coverage_graph_ms",
]

COUNTERS = [
    "parse_calls_total",
    "parse_distinct_files",
    "affected_file_count",
    "reparsed_file_count",
    "recompiled_file_count",
    "reused_file_count",
    "coverage_summaries_reused",
    "coverage_summaries_rebuilt",
    "reverse_dependents_invalidated",
    "negative_resolutions_invalidated",
    "full_fallback_count",
    "semantic_builds",
    "pass1_calls",
    "pass2_calls",
    "read_calls",
    "read_bytes",
    "write_calls",
    "written_bytes",
    "atoms",
    "atom_contributions",
    "stat_calls",
    "resolution_probes",
    "rss_peak_bytes",
    "heap_peak_bytes",
]


def run_summarize(observations: Path, out_path: Path):
    subprocess.run(
        [sys.executable, str(SUMMARIZE), "-i", str(observations), "-o", str(out_path)],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    return json.loads(out_path.read_text(encoding="utf-8"))


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


def row(summary, corpus, scenario, cache_state, metric, engine, run_kind="qualification"):
    return stats_for(summary, engine, corpus, scenario, cache_state, metric, run_kind)


def comparison(summary, corpus, scenario, cache_state, metric=KPI, run_kind="qualification"):
    a = row(summary, corpus, scenario, cache_state, metric, REFERENCE, run_kind)
    b = row(summary, corpus, scenario, cache_state, metric, VARIANT, run_kind)
    if a is None or b is None:
        return None
    a_bad = {k: v for k, v in a["status_counts"].items() if k != "ok"}
    b_bad = {k: v for k, v in b["status_counts"].items() if k != "ok"}
    comparable = not a_bad and not b_bad
    am, bm = med(a), med(b)
    absolute = relative = None
    if comparable and am not in (None, 0) and bm is not None:
        absolute = bm - am
        relative = (bm - am) / am * 100.0
    return {
        "corpus": corpus,
        "scenario": scenario,
        "cache_state": cache_state,
        "metric": metric,
        "comparable": comparable,
        "comparability_note": (
            "" if comparable else f"status differs: full={a_bad} incremental={b_bad}; NOT ranked"
        ),
        "full_median_ms": am,
        "full_p95_ms": med(a, "p95_upper_rank"),
        "full_n": med(a, "count"),
        "incremental_median_ms": bm,
        "incremental_p95_ms": med(b, "p95_upper_rank"),
        "incremental_n": med(b, "count"),
        "absolute_delta_ms": absolute,
        "relative_delta_pct": relative,
        "speedup": (am / bm) if (comparable and bm not in (None, 0) and am) else None,
    }


def counter_pair(summary, corpus, scenario, cache_state, metric, run_kind="qualification"):
    a = row(summary, corpus, scenario, cache_state, metric, REFERENCE, run_kind)
    b = row(summary, corpus, scenario, cache_state, metric, VARIANT, run_kind)
    return {
        "metric": metric,
        "full": med(a),
        "incremental": med(b),
    }


def table(rows, headers):
    out = ["| " + " | ".join(headers) + " |",
           "| " + " | ".join("---" for _ in headers) + " |"]
    for r in rows:
        out.append("| " + " | ".join(str(c) for c in r) + " |")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--c1000", type=Path)
    ap.add_argument("--c10000", type=Path)
    ap.add_argument("--oracle", type=Path)
    ap.add_argument("--long-session", type=Path)
    ap.add_argument("--out-dir", type=Path, required=True)
    ap.add_argument("--run-kind", default="qualification")
    args = ap.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)

    data = {"documentKind": "pandamstyle-spike-2-report-data", "batch": "spike-2"}
    summaries = {}
    for label, stream in (("c1000", args.c1000), ("c10000", args.c10000)):
        if stream is None or not stream.exists():
            continue
        out = args.out_dir / f"{label}-summary.json"
        summaries[label] = run_summarize(stream, out)
        data.setdefault("summaries", {})[label] = out.name
        data.setdefault("corpora", {})[label] = {
            "observations": stream.name,
            "observation_count": summaries[label]["observation_count"],
            "malformed_lines": summaries[label]["malformed_lines"],
        }

    # ---- correctness -------------------------------------------------------
    if args.oracle is not None and args.oracle.exists():
        oracle = json.loads(args.oracle.read_text(encoding="utf-8"))
        data["correctness"] = {
            "verdict": oracle["verdict"],
            "revisions_compared": oracle["revisionsCompared"],
            "mismatches": oracle["mismatches"],
            "errors": oracle["errors"],
            "corpus": oracle["corpus"],
            "checks_per_revision": oracle["checksPerRevision"],
            "normalisation": oracle["normalisation"],
            "fresh_rebuild_isolation": oracle["freshRebuildIsolation"],
            "full_fallback_scenarios": sorted(
                {
                    r["sessionCounters"]["fullFallbackReason"]
                    for r in oracle["revisions"]
                    if r.get("sessionCounters", {}).get("fullFallbackReason")
                }
            ),
            "per_scenario": [
                {
                    "scenario": r["scenario"],
                    "revision": r["revision"],
                    "session": r.get("sessionVerdict"),
                    "full": r.get("fullVerdict"),
                    "equivalent": r["equivalent"],
                    "files_reparsed": (r.get("sessionCounters") or {}).get("filesReparsed"),
                    "files_recompiled": (r.get("sessionCounters") or {}).get("filesRecompiled"),
                    "files_reused": (r.get("sessionCounters") or {}).get("filesReused"),
                    "reverse_dependents_invalidated": (r.get("sessionCounters") or {}).get(
                        "reverseDependentsInvalidated"
                    ),
                    "negative_resolutions_invalidated": (r.get("sessionCounters") or {}).get(
                        "negativeResolutionsInvalidated"
                    ),
                    "full_fallback_reason": (r.get("sessionCounters") or {}).get(
                        "fullFallbackReason"
                    ),
                }
                for r in oracle["revisions"]
            ],
        }

    if args.long_session is not None and args.long_session.exists():
        trace = json.loads(args.long_session.read_text(encoding="utf-8"))
        data["long_session"] = {
            "edits": trace["edits"],
            "gc_exposed": trace["gcExposed"],
            "stable": trace["stable"],
            "mix": trace["mix"],
            "memory": trace["memory"],
            "structural": trace["structural"],
            "final_no_change_revision_ms": trace["finalNoChangeRevisionMs"],
            "digest": trace["digest"],
        }

    # ---- the decision-bearing table ---------------------------------------
    headline_scenarios = [
        "no_change",
        "format_only",
        "one_file_existing_atoms",
        "one_file_new_atom",
        "five_files_batch",
        "forbidden_value",
        "repair_forbidden_value",
    ]
    graph_scenarios = [
        "import_change",
        "reexport_change",
        "module_add",
        "module_remove",
        "file_rename",
        "resolution_config_change",
    ]
    fallback_scenarios = [
        "token_value",
        "token_remove",
        "token_restore",
        "semantic_alias",
        "theme_value",
        "condition_value",
        "condition_remove",
        "recipe_branch",
        "recipe_interface",
        "policy_category",
        "policy_global",
        "config_change",
    ]

    data["comparisons"] = []
    for label, summary in summaries.items():
        corpus = summary["summary"][0]["corpus"] if summary["summary"] else None
        if corpus is None:
            continue
        for cache_state in (
            "process_warm_edit",
            "process_warm_no_edit",
            "process_cold_cache_empty",
        ):
            for scenario in headline_scenarios + graph_scenarios + fallback_scenarios:
                c = comparison(summary, corpus, scenario, cache_state, KPI, args.run_kind)
                if c is not None:
                    c["corpus"] = corpus
                    data["comparisons"].append(c)

    for label, summary in summaries.items():
        corpus = summary["summary"][0]["corpus"] if summary["summary"] else None
        if corpus is None:
            continue
        counters = []
        for scenario in headline_scenarios + graph_scenarios + fallback_scenarios:
            for cache_state in (
                "process_warm_edit",
                "process_warm_no_edit",
                "process_cold_cache_empty",
            ):
                for metric in COUNTERS:
                    pair = counter_pair(summary, corpus, scenario, cache_state, metric, args.run_kind)
                    if pair["full"] is None and pair["incremental"] is None:
                        continue
                    pair["corpus"] = corpus
                    pair["scenario"] = scenario
                    pair["cache_state"] = cache_state
                    counters.append(pair)
        data.setdefault("counters", {})[label] = counters

        phases = []
        for scenario in ("no_change", "one_file_new_atom", "five_files_batch"):
            for cache_state in ("process_warm_edit", "process_warm_no_edit"):
                for metric in PHASES:
                    pair = counter_pair(summary, corpus, scenario, cache_state, metric, args.run_kind)
                    if pair["full"] is None and pair["incremental"] is None:
                        continue
                    pair["corpus"] = corpus
                    pair["scenario"] = scenario
                    pair["cache_state"] = cache_state
                    phases.append(pair)
        data.setdefault("phases", {})[label] = phases

        stages = []
        for scenario in ("no_change", "one_file_new_atom", "five_files_batch"):
            for cache_state in ("process_warm_edit", "process_warm_no_edit"):
                for metric in STAGES:
                    pair = counter_pair(summary, corpus, scenario, cache_state, metric, args.run_kind)
                    if pair["full"] is None and pair["incremental"] is None:
                        continue
                    pair["corpus"] = corpus
                    pair["scenario"] = scenario
                    pair["cache_state"] = cache_state
                    stages.append(pair)
        data.setdefault("stages", {})[label] = stages

    out = args.out_dir / "report-data.json"
    out.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
