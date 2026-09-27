# Open Questions for Repository Analysis

GPT-6 Pro should resolve these from the actual StyleX codebase rather than guessing.

1. Where is the cleanest compile-time validation hook for property/value pairs?
2. Can token typing be generated without degrading editor performance?
3. How are StyleX variables currently represented, and can semantic tokens reuse that mechanism?
4. Can conditions be expressed through existing StyleX mechanisms rather than creating a parallel syntax?
5. What is the minimal abstraction required for recipes while retaining fully static extraction?
6. Should recipes live in the StyleX fork or in a higher LB Frame package built on top of the fork?
7. Same question for slot recipes.
8. Which features actually require forking core StyleX versus building an upstream-compatible package?
9. Can strict-token validation be implemented as a plugin/compiler extension?
10. What permanent merge-conflict surface would the fork create?
11. What exact package/export structure best prevents application-level raw StyleX imports?
12. How should escape hatches be represented so they are auditable?
13. Should nearest-token suggestions live in compiler core or a diagnostics package?
14. Can the design-system manifest be produced as a build artifact without impacting normal compilation?
15. What performance cost is introduced by token lookup, alias resolution and diagnostics?
16. Can semantic token cycles be detected statically?
17. How should dark mode / theme switching interact with semantic tokens?
18. How should multi-brand themes be represented?
19. Which constraints belong in the compiler versus TypeScript types versus lint rules?
20. What is the smallest P0 that proves the architecture before deeper fork divergence?
