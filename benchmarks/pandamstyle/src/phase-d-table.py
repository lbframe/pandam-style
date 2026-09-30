#!/usr/bin/env python3
"""Phase D table renderer: one row per (corpus, variant, scenario, metric)."""
import json
import statistics
import sys
from collections import defaultdict


def load(paths):
    rows = []
    for p in paths:
        with open(p) as f:
            for line in f:
                if line.strip():
                    rows.append(json.loads(line))
    return rows


def main():
    rows = load(sys.argv[3:])
    want = sys.argv[1]
    label = sys.argv[2]
    metrics = [
        m for m in dict.fromkeys(r["metric"] for r in rows)
        if m in (
            "agent_edit_to_diagnostics_ms",
            "unaccounted_diagnostics_ms",
            "agent_edit_to_generation_committed_ms",
            "agent_edit_to_generation_ready_ms",
            "phase:session_scan_ms",
            "phase:session_closure_ms",
            "phase:session_dsv_view_ms",
            "phase:session_compile_files_ms",
            "phase:session_compile_affected_ms",
            "phase:session_reuse_iteration_ms",
            "phase:session_coverage_entries_ms",
            "counter:closure_nodes_examined",
            "counter:closure_nodes_reused",
            "counter:closure_nodes_added",
            "counter:closure_nodes_removed",
            "counter:closure_edges_recomputed",
            "counter:closure_reachability_updates",
            "counter:closure_full_walk",
            "counter:closure_full_fallback",
            "counter:closure_update_ms",
            "counter:dsv_files_examined",
            "counter:dsv_files_recomputed",
            "counter:dsv_files_reused",
            "counter:dsv_relay_nodes_touched",
            "counter:dsv_consumers_invalidated",
            "counter:dsv_relay_hits",
            "counter:dsv_relay_walks",
            "counter:dsv_full_fallback",
            "counter:dsv_update_ms",
            "counter:parse_calls",
            "counter:files_recompiled",
            "counter:dirty_files_read",
            "counter:dirty_files_hashed",
        )
    ]
    grouped = defaultdict(list)
    for r in rows:
        if r["metric"] in metrics and r["value"] is not None:
            grouped[(r["corpus"], r["variant"], r["scenario"], r["metric"])].append(r["value"])

    print(f"### {label}\n")
    keys = sorted({k[:3] for k in grouped})
    header = ["metric"] + [f"{v}|{s}" for _, v, s in keys]
    print("| " + " | ".join(header) + " |")
    print("|" + "---|" * len(header))
    for metric in metrics:
        line = [metric]
        for k in keys:
            vals = grouped.get((*k, metric))
            if not vals:
                line.append("-")
                continue
            med = statistics.median(vals)
            line.append(f"{med:.3f}" if med != int(med) else f"{int(med)}")
        if all(x == "-" for x in line[1:]):
            continue
        print("| " + " | ".join(line) + " |")


if __name__ == "__main__":
    main()
