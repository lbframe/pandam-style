# Phase 7 performance comparison

The 10k profile ran on tested commit
`4e72cf32e498d5f4c3be0a9153c1d9c9aaba1d0a` against the same corpus content hash
as the Phase 5 baseline: `91ad54984875a9226624413db899415bad8ff7427810099f234350e927c964da`.
It used 30 isolated process cells (two variants × five scenarios × three
repetitions), produced 1,956 rows, and recorded zero failed cells.

| Scenario | Phase 5 p50 | Phase 7 p50 | Change |
| --- | ---: | ---: | ---: |
| Style edit diagnostics | 65.617 ms | 59.100 ms | −9.93% |
| Import edit diagnostics | 31.859 ms | 21.574 ms | −32.28% |
| Re-export edit diagnostics | 113.372 ms | 111.121 ms | −1.99% |
| Unresolved import repair | 77.018 ms | 63.031 ms | −18.16% |
| No-change diagnostics | 61.618 ms | 58.959 ms | −4.31% |
| Publication ready | 563.465 ms | 507.407 ms | −9.95% |
| Publication committed | 700.908 ms | 629.549 ms | −10.18% |

All 40 compared work counters were unchanged, including `full_fallback = 0`,
the examined/reused closure counts, design-system view work, and covered-entry
iteration counts. The raw rows and comparison JSON are beside this file.

This latency series measures the low-level incremental-session benchmark path;
it is not a Project Service wrapper benchmark. The separate one-sample public
service profile recorded:

| Service operation | Wall time | Queue wait | Queue run |
| --- | ---: | ---: | ---: |
| `applyChanges` | 5.164 ms | 0.012 ms | 5.069 ms |
| `validate` | 57.168 ms | 0.011 ms | 57.124 ms |
| `host.readArtifact` | 115.547 ms | 0.011 ms | 115.488 ms |
| `preparePublication` | 162.387 ms | 0.009 ms | 162.323 ms |
| `commitPrepared` | 605.317 ms | 0.010 ms | 605.226 ms |

The commit materialized 10,004 hard links, changed two outputs, and wrote
4,338 bytes. Service timings are one style transaction with no wrapper baseline.
Three samples do not provide a confidence interval; these measurements are
observations, not universal estimates or a causal attribution.

The service measurement harness is stored as
`phase7-service-overhead.mjs.txt` because the repository's configured Hermes
Prettier parser cannot parse this Node ESM dynamic-import expression. From the
repository root, run it with:

```sh
node --input-type=module < evidence/phase-7-project-service/performance/phase7-service-overhead.mjs.txt
```
