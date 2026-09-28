#!/usr/bin/env python3
# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.
"""Assemble the committed Spike 1 evidence from a finished campaign.

STORAGE POLICY, STATED UP FRONT

Committed: corpus manifests (small, and the identity of every number), campaign
metadata, summaries, the per-run phase/parse tables, the profile summaries, the
differential-oracle verdicts, and the generated report.

NOT committed: the raw observation JSONL and the per-parse event files. They are
real data, they are not deleted, and their sha256 is recorded in the index so a
reader can verify what was summarised. The raw stream is several hundred
megabytes for this batch, and a repository is not where megabytes of repeated
timings belong. Where the raw data lives is recorded in the index; if that
location stops resolving, the summaries are still honest about what they
summarised but the per-observation values are gone, and the index says so.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BENCH_ROOT = HERE.parent
REPO_ROOT = BENCH_ROOT.parent.parent


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-dir", required=True, help="the .pms-bench scratch root")
    parser.add_argument("--out", required=True, help="evidence/performance/spike-1")
    parser.add_argument(
        "--profiles", nargs="*", default=[], help="profile.js output directories"
    )
    parser.add_argument(
        "--differentials", nargs="*", default=[], help="differential.js report files"
    )
    parser.add_argument(
        "--raw-retention",
        default="archive-off-repo",
        help="where the raw observation stream is kept; recorded verbatim in the index",
    )
    args = parser.parse_args()

    work = Path(args.work_dir)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    index = {
        "documentKind": "pandamstyle-spike1-evidence-index",
        "schemaVersion": 1,
        "storage_policy": {
            "committed": [
                "corpus manifests (the identity of every number)",
                "campaign metadata (environment, engines, commits, policy, every job)",
                "summaries (median, p95, variance, status counts, sessions)",
                "phase and counter tables",
                "parse evidence, in aggregated form: counts per file and per pipeline",
                "profile summaries",
                "differential-oracle verdicts",
            ],
            "not_committed": [
                "the raw observation JSONL",
                "the per-parse event files (every parse, every module-cache lookup, in order)",
            ],
            "not_committed_reason": (
                "The raw stream is hundreds of megabytes of repeated timings. It is "
                "NOT deleted; its sha256 is recorded below and its location is "
                "recorded, so a reader can verify that the summaries were computed "
                "from exactly these bytes."
            ),
            "raw_retention_location": args.raw_retention,
        },
        "raw": [],
        "summaries": [],
        "profiles": [],
        "differentials": [],
        "corpus_manifests": [],
    }

    # ---------------------------------------------------------------- corpora
    corpora_dir = work / "corpora"
    if corpora_dir.is_dir():
        for manifest_path in sorted(corpora_dir.glob("*/corpus-manifest.json")):
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            dest = out / "corpora" / manifest_path.parent.name / "corpus-manifest.json"
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(manifest_path, dest)
            index["corpus_manifests"].append(
                {
                    "name": manifest["name"],
                    "content_hash": manifest["contentHash"],
                    "design_system_hash": manifest["designSystemHash"],
                    "parameters": manifest["parameters"],
                    "counts": manifest["counts"],
                    "expected_state": manifest["expectedState"],
                    "file": str(dest.relative_to(REPO_ROOT)),
                }
            )

    # ------------------------------------------------------------- campaigns
    qual = work / "qualification"
    if qual.is_dir():
        for obs_path in sorted(qual.glob("*.jsonl")):
            rows = read_jsonl(obs_path)
            if not rows:
                continue
            meta_path = obs_path.with_name(
                obs_path.name.replace(".jsonl", "-metadata.json")
            )
            meta = (
                json.loads(meta_path.read_text(encoding="utf-8"))
                if meta_path.exists()
                else None
            )
            name = obs_path.stem
            # The raw stream: summarised, digested, and left in place.
            index["raw"].append(
                {
                    "name": name,
                    "path": str(obs_path),
                    "sha256": sha256_file(obs_path),
                    "bytes": obs_path.stat().st_size,
                    "observations": len(rows),
                    "committed": False,
                    "retained_at": args.raw_retention,
                }
            )

            if meta is not None:
                dest = out / "campaigns" / f"{name}-metadata.json"
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(meta_path, dest)
                meta["observations_sha256"] = sha256_file(obs_path)
                dest.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")

            # summarize.py is the only implementation of the arithmetic.
            summary_out = out / "campaigns" / f"{name}-summary.json"
            summary_out.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(
                [
                    sys.executable,
                    str(BENCH_ROOT / "summarize.py"),
                    "-i",
                    str(obs_path),
                    "-o",
                    str(summary_out),
                ],
                check=True,
                stdout=subprocess.DEVNULL,
            )
            index["summaries"].append(
                {
                    "name": name,
                    "file": str(summary_out.relative_to(REPO_ROOT)),
                    "observations": len(rows),
                    "jobs": (meta or {}).get("summary"),
                }
            )

            # Per-file and per-pipeline parse accounting, aggregated from the
            # event files. The events themselves are not committed; the
            # distribution they produce is.
            parse_files = sorted((work / "parse-evidence").glob(f"*{name.replace('-', '-')}*.parses.json"))
            matched = [
                p
                for p in sorted((work / "parse-evidence").glob("*.parses.json"))
                if name.split(".")[0] in p.name or True
            ]
            matched = [
                p
                for p in matched
                if any(
                    tok in p.name
                    for tok in _cell_tokens(rows, name)
                )
            ]
            if matched:
                agg = out / "campaigns" / f"{name}-parse-accounting.json"
                agg.parent.mkdir(parents=True, exist_ok=True)
                agg.write_text(
                    json.dumps(aggregate_parses(matched), indent=2) + "\n",
                    encoding="utf-8",
                )
                index["summaries"].append(
                    {
                        "name": f"{name}-parse-accounting",
                        "file": str(agg.relative_to(REPO_ROOT)),
                        "event_files": len(matched),
                        "note": (
                            "aggregated from every parse event of every job in this "
                            "run; the raw event files are not committed"
                        ),
                    }
                )

    # -------------------------------------------------------------- profiles
    for profile_dir in args.profiles:
        p = Path(profile_dir) / "profiles.json"
        if not p.exists():
            continue
        dest = out / "profiles" / f"{Path(profile_dir).name}.json"
        dest.parent.mkdir(parents=True, exist_ok=True)
        report = json.loads(p.read_text(encoding="utf-8"))
        # The raw .cpuprofile files are large; the aggregated tables are kept.
        for result in report.get("results", []):
            result.pop("selfTime", None)
        dest.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        index["profiles"].append(
            {
                "source": profile_dir,
                "file": str(dest.relative_to(REPO_ROOT)),
                "runs": [
                    {
                        "corpus": r.get("corpus"),
                        "engine": r.get("engine"),
                        "status": r.get("status"),
                        "wall_ms": r.get("wall_ms"),
                        "samples": r.get("samples"),
                    }
                    for r in report.get("results", [])
                ],
                "note": (
                    "A sampling profiler perturbs what it observes. These were "
                    "taken in separate invocations from the latency campaign and "
                    "nothing in them is a latency measurement."
                ),
            }
        )

    # --------------------------------------------------------- differentials
    for diff_path in args.differentials:
        p = Path(diff_path)
        if not p.exists():
            continue
        dest = out / "correctness" / p.name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(p, dest)
        report = json.loads(p.read_text(encoding="utf-8"))
        index["differentials"].append(
            {
                "file": str(dest.relative_to(REPO_ROOT)),
                "corpus": report.get("corpus"),
                "verdict": report.get("verdict"),
                "scenarios_compared": report.get("scenariosCompared"),
                "errors": len(report.get("errors", [])),
                "checks": report.get("checksPerScenario"),
            }
        )

    # ----------------------------------------------------------------- index
    index_path = out / "INDEX.json"
    index_path.write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {index_path}")
    print(
        f"  corpora={len(index['corpus_manifests'])} "
        f"summaries={len(index['summaries'])} "
        f"profiles={len(index['profiles'])} "
        f"differentials={len(index['differentials'])} "
        f"raw_streams={len(index['raw'])}"
    )


def _cell_tokens(rows, name):
    """The corpus and scenario tokens that identify a run's job files."""
    tokens = set()
    for r in rows:
        corpus = r.get("corpus")
        if corpus:
            tokens.add(corpus)
    if not tokens:
        tokens.add(name)
    return tokens


def aggregate_parses(files):
    """Aggregates every parse event of a run into a committed-sized document."""
    by_pipeline = {}
    by_file_max = {}
    per_corpus = {}
    module_lookups = {}
    real_parses = 0
    lookups = 0
    events_total = 0
    for f in files:
        try:
            doc = json.loads(f.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        corpus = doc.get("corpus")
        for event in doc.get("events", []):
            parses = event.get("parses", {})
            for pipeline, n in (parses.get("by_pipeline") or {}).items():
                key = f"{corpus}|{pipeline}"
                by_pipeline[key] = by_pipeline.get(key, 0) + n
                real_parses += n
            for pipeline, n in (parses.get("by_pipeline") or {}).items():
                pass
            real = parses.get("total", 0)
            look = parses.get("module_cache_lookups", 0)
            real_parses += 0
            lookups += look
            most = parses.get("most_consulted_module")
            if most:
                module_lookups[corpus] = max(module_lookups.get(corpus, 0), most[1])
            m = parses.get("max_parses_per_file", 0)
            by_file_max[corpus] = max(by_file_max.get(corpus, 0), m)
            events_total += real + look
    return {
        "documentKind": "pandamstyle-spike1-parse-accounting",
        "note": (
            "Aggregated over every job in the run. 'real parses' counts only parse "
            "events; a module-cache hit is a LOOKUP and is counted separately, "
            "because conflating the two would answer a different question under "
            "the same name."
        ),
        "real_parses_total": real_parses,
        "module_cache_lookups_total": lookups,
        "events_total": events_total,
        "real_parses_by_corpus_and_pipeline": by_pipeline,
        "max_real_parses_of_one_file_by_corpus": by_file_max,
        "max_module_cache_lookups_of_one_file_by_corpus": module_lookups,
    }


if __name__ == "__main__":
    main()
