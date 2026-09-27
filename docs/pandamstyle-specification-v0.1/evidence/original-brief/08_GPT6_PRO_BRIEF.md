# Brief for GPT-6 Pro

You are acting as a principal frontend compiler / design-systems engineer.

## Task

Analyze the current StyleX repository and design the safest path to fork it into an LB Frame agent-first style system.

The goal is not to merge Panda CSS wholesale into StyleX.

The goal is:

> Preserve StyleX's compiler/static-extraction strengths and graft onto it the strongest Panda-style constraints needed for a highly deterministic, agent-friendly design system.

Read every file in this bundle before proposing implementation.

## Required outcomes

Produce:

1. **Repository architecture map**
   - packages
   - compiler flow
   - parser/transform stages
   - typing layer
   - runtime layer
   - plugin interfaces
   - CSS emission path
   - best extension points

2. **Gap analysis**
   For every requested capability, classify:
   - already supported
   - partially supported
   - missing
   - conflicts with StyleX architecture

3. **Implementation matrix**
   Use:
   - KEEP
   - EXTEND
   - PORT CONCEPT
   - BUILD
   - DROP / FORBID

4. **P0 implementation plan**
   Cover:
   - strict tokens
   - semantic tokens
   - theme-derived typing
   - recipes
   - controlled conditions
   - agent-friendly diagnostics
   - public import boundary

5. **Minimal invasive architecture**
   Prefer extension points over broad rewrites.

6. **File-level implementation plan**
   Name:
   - files/packages to modify
   - files/packages to add
   - APIs to expose
   - tests to add

7. **Compatibility analysis**
   Explain what remains upstream-compatible and what creates permanent fork divergence.

8. **Testing strategy**
   Include:
   - unit tests
   - compiler fixtures
   - TS type tests
   - negative compile tests
   - static CSS snapshots
   - diagnostics tests
   - performance regression tests

9. **Agent ergonomics review**
   Evaluate whether a coding agent can repair every common invalid style from compiler output alone.

10. **Risk register**
   Especially:
   - compiler complexity
   - type-system explosion
   - CSS output changes
   - upstream merge difficulty
   - runtime leakage
   - unsafe escape hatches
   - recipes causing runtime behavior
   - semantic-token alias resolution

## Constraints

- Do not introduce a second public styling system.
- Do not expose Panda as a parallel runtime/dependency merely to obtain these features.
- Do not rely only on ESLint for critical guarantees.
- Do not turn static StyleX behavior into runtime style computation.
- Do not copy Panda internals blindly.
- Preserve StyleX architecture wherever possible.
- Prefer compile-time validation.
- Errors must be machine-readable and repair-oriented.
- Agent-generated application code should import LB Frame's public style/UI layer, not raw StyleX.
- Arbitrary CSS must remain possible only behind deliberate escape hatches where genuinely needed.

## P0 priority order

1. strict tokens
2. semantic tokens
3. theme-derived types
4. controlled conditions
5. recipes
6. diagnostics
7. import boundary

You may reorder only if repository architecture makes a different dependency order technically necessary. Explain why.

## Deliverable format

Create:

```text
analysis/
├── ARCHITECTURE.md
├── GAP_ANALYSIS.md
├── FEATURE_MATRIX.md
├── P0_IMPLEMENTATION_PLAN.md
├── API_PROPOSAL.md
├── FILE_CHANGE_PLAN.md
├── TEST_PLAN.md
├── UPSTREAM_COMPATIBILITY.md
├── RISK_REGISTER.md
└── DECISION.md
```

`DECISION.md` must clearly state:
- recommended architecture
- exact P0 scope
- what NOT to build yet
- expected permanent fork surface
- whether the fork is technically justified after inspecting the repository

Do not implement code until the architecture and P0 plan are internally coherent.

If implementation is requested after analysis, work in small reviewable commits and preserve upstream attribution/license requirements.
