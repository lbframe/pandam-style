# Combined qualification evidence

All qualification records in this directory are newly produced against tested
commit `c4c6b07a7124370b4d9de04bafc8101a7a497c7d`, tree
`a1ec19d6f9d13fb37496c2f8b2df036342937bd9`. Historical phase measurements
are reference context only. `verify/env.json` records the clean tested checkout
before the verifier wrote output. The final commit adds only evidence and the
reconciliation delivery document.

- `verify/summary.json`: all nine official steps, counts and completeness.
- `verify/semantic-oracle/`: unchanged authored cases, per-revision checks,
  six browser/SSR cases, inventory and Jest execution evidence.
- `verify/phase-6-typescript.json`: generated declaration positive and negative
  checks, exact rejected lines, size and timings.
- `verify/phase-6-mutations.json`: the retained Phase 6 multi-revision mutation
  matrix rerun in the combined tree.
- `verify/phase-6-7-qualification.json`: the 21 new service reconciliation
  assertions, including foreign staged members, complete-set cold reuse,
  canonical domain repairs, isolation, one rebuild/revision and recovery.
- `artifact-coherence-report.json`, `generated-typescript-report.json`,
  `private-vocabulary-leak-scan.json`, `project-isolation-report.json`,
  `concurrency-report.json`, `publication-recovery-report.json`, and
  `cold-reopen-artifact-set-reuse-report.json`: focused evidence with references
  to actual combined test execution and measured samples.
- `performance/`: isolated local 10k cell observations, corpus manifest,
  comparisons and a public service local/global profile. Generated members
  are saved as `.txt` sidecars to preserve exact bytes through source hooks.
- `worktree-isolation-report.json`: protected source heads/status before and
  after, plus local and remote main references.
- `sdk-surface-report.json`: exact root/config/host runtime exports.
- `donor-package-closure-report.json`: current official closure reports.

The local corpus has Phase 6's content hash
`f1d6c857aa6ef311b8deeadf16ff740090f78eaac3ab2d0fa7481e89d46f78be`.
Phase 7's historic corpus used the earlier bridge marker; its hash differs.
Work shape comparisons use the same parameters and unchanged source topology;
historical latency deltas are contextual, without a causal claim or confidence
interval. The public service profile is one measured sample and is reported
separately from three independent local benchmark cell processes per case.
