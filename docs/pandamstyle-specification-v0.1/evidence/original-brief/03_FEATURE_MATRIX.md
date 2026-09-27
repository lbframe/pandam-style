# Feature Matrix — KEEP / PORT / BUILD / DROP

| Area | Decision | Source / Direction | Notes |
|---|---|---|---|
| Static extraction | KEEP | StyleX | Preserve core strength |
| Atomic CSS generation | KEEP | StyleX | Preserve unless repo analysis finds incompatibility |
| Colocated style authoring | KEEP | StyleX | Keep developer ergonomics |
| Compiler architecture | KEEP | StyleX | Extend through clean validation hooks |
| Direct raw StyleX use in app code | DROP / RESTRICT | LB policy | Infrastructure only |
| Strict tokens | PORT | Panda idea | Must be compile-time enforceable |
| Semantic tokens | PORT | Panda idea | First-class, not ad-hoc aliases |
| Theme-derived typings | PORT | Panda idea | Generate unions/types from theme |
| Recipes | PORT | Panda idea | Variants + defaults |
| Compound variants | PORT | Panda idea | P1 |
| Slot recipes | BUILD / PORT concept | Panda-style concept | Important for complex components |
| Patterns | PORT concept | Panda idea | P1; composition primitives |
| Breakpoint conditions | PORT | Panda idea | Controlled and typed |
| Named conditions | PORT | Panda idea | hover, reduced motion, compact, etc. |
| Arbitrary-value policy | BUILD | LB-specific | Fine-grained per category |
| Agent diagnostics | BUILD | LB-specific | Repair-oriented error messages |
| Nearest-token suggestions | BUILD | LB-specific | Critical agent ergonomics |
| Token deprecation | BUILD | LB-specific | P2 |
| Token versioning metadata | BUILD | LB-specific | P2 |
| Machine-readable design-system manifest | BUILD | LB-specific | Strongly recommended |
| ESLint-only enforcement | DROP as primary guard | — | Lint can supplement compiler enforcement |
| Runtime CSS-in-JS fallback | DROP if unnecessary | — | Preserve static determinism |
| Two styling APIs exposed to app code | DROP | — | One public API only |
