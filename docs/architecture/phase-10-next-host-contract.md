# Phase 10 Next host contract

Status: implementation candidate, **not a support or completion claim**.
The [feasibility decision](phase-10-next-host-feasibility.md) freezes exact
Next 16.3.8 + webpack as the first candidate and stops Turbopack implementation.

## Public SDK audit before implementation

| Next need | Existing Project Service operation | Existing /host operation | Sufficient? | Minimal extension / compiler ownership |
| --- | --- | --- | --- | --- |
| Create isolated project/output authority | `createProjectSession`, `initialize`, `close` | None | Yes within one owner process | None |
| Exact source before SWC/Flight | `applyChanges` with `sourceOverlays` | `readArtifact` and `sourceDigest` | Yes | None; source/provenance remains compiler-owned |
| Read unpublished facade and CSS | Validate exact revision | `readGeneratedArtifacts` | Yes | None; generated projections remain compiler-owned |
| Watch add/delete/rename/unresolved repair | `watch`, `applyChanges`, `auditMutationSet` | None | Yes | None; host supplies lifecycle transport only |
| Structured invalid/repair diagnostics | `validate`, `agentResult`, `candidateTokens` | None | Yes | None; preserve Diagnostics Protocol v1 |
| Global Design System mutation | `applyChanges({definition})` | Exact generated-set read | Yes | None; snapshot/fallback remain compiler-owned |
| Successful host compilation publication | Current revision/validation | `preparePublication`, `commitPrepared`, `abortPrepared` | Yes only if host supplies an adequate completion hook | None; missing Turbopack dev hooks are a host API blocker |
| Multiple workers sharing one authority | Public SDK may be relayed by transport | Same operations | Requires host transport or explicit unsupported-mode rejection | No internal-session escape hatch |
| Close/restart/failure retention | `close`, `initialize`, `current` | Abort/stale ticket rejection | Yes | None; durable recovery remains compiler-owned |

No SDK extension is authorized by this audit. Any later discovered SDK change
must be recorded as a mandatory Phase 10+11 checkpoint surface before use.

## Proposed public entry and package boundary

```js
import { withPandamStyle } from '@pandamstyle/next';

export default withPandamStyle({
  backend: 'webpack',
  definition: './design.pandamstyle.config.js',
  roots: ['./app', './components'],
})(nextConfig);
```

The enhancer composes object, async and function Next configurations using
public NextConfig types. Backend is required. Turbopack and unqualified Next
versions reject before service initialization. Applications import their
generated facade and CSS; adapter imports occur only in build configuration.

Next is an exact peer for the qualification target. The adapter depends only
on compiler 0.1.0 public root and /host entries. No private compiler import,
runtime React component, semantic graph, rule registry, CSS model or canonical
writer is permitted. Generated application runtime remains core-only.

## Qualification and scope

Webpack source transport, dev invalidation/repair, production settlement,
RSC/client directives, SSR/hydration/navigation/cache, worker ownership,
publication failures and external tarball installation all require independent
observations. Candidate status does not substitute for any row.

The official verifier must retain all ten base steps and require
`next-qualification` as an eleventh. A blocked backend cannot be marked passed,
skipped into completion, or hidden behind webpack results. Only a clean tested
commit may underlie final qualification. Evidence-only closure cannot add
implementation or verifier changes after that commit.

Phase 11 remains independent. Large pilots, PR creation, merge and publication
are outside this brief. The Phase 10+11 checkpoint remains mandatory.
