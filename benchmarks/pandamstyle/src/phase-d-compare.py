#!/usr/bin/env python3
"""Phase D comparison table: one column per measured build, one row per scenario."""
import json
import statistics
import sys


def load(path):
    rows = []
    with open(path) as handle:
        for line in handle:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def median(rows, variant, scenario, revision, metric):
    values = [
        row["value"]
        for row in rows
        if row["variant"] == variant
        and row["scenario"] == f"{scenario}#{revision}"
        and row["metric"] == metric
        and row["value"] is not None
    ]
    return statistics.median(values) if values else None


def fmt(value):
    if value is None:
        return "-"
    return f"{value:.2f}" if abs(value - round(value)) > 1e-9 else f"{int(value)}"


SCENARIOS = [
    ("one_file_existing_atoms", "edit", "1-file style edit"),
    ("one_file_new_atom", "new_atom", "1-file new atom"),
    ("five_files_batch", "edit", "5-file transaction"),
    ("twenty_files_batch", "edit", "20-file transaction"),
    ("forbidden_value", "break", "invalid forbidden value"),
    ("repair_forbidden_value", "repair", "repair, after the violation"),
    ("import_change", "import", "import change"),
    ("reexport_change", "reexport", "re-export change"),
    ("module_add", "add", "module add"),
    ("module_remove", "remove", "module remove"),
    ("file_rename", "rename", "rename"),
    ("unresolved_import_then_file_appears", "appears", "unresolved import repaired"),
    ("token_value_full_fallback", "definition", "design-system fallback"),
    ("no_change", "declared_unchanged", "declared no-change"),
]

VARIANT = "compact_agent_result"


def label_for(path):
    name = path.split("/")[-1]
    for suffix in ("-diagnostics.jsonl", "-campaign.jsonl", "-publish.jsonl", ".jsonl"):
        if name.endswith(suffix):
            name = name[: -len(suffix)]
            break
    return (
        name.replace("baseline-", "PhaseC-")
        .replace("d1-", "D1-")
        .replace("d3-", "D1D2-")
    )


def main():
    title = sys.argv[1]
    metric = sys.argv[2]
    files = sys.argv[3:]
    sets = [load(path) for path in files]
    labels = [label_for(path) for path in files]

    print(f"### {title}")
    print()
    print("| scenario | " + " | ".join(labels) + " |")
    print("|" + "---|" * (len(files) + 1))
    for scenario, revision, name in SCENARIOS:
        cells = [fmt(median(s, VARIANT, scenario, revision, metric)) for s in sets]
        print(f"| {name} | " + " | ".join(cells) + " |")


if __name__ == "__main__":
    main()
