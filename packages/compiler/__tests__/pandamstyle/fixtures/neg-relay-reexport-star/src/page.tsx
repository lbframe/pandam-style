/**
 * The covered root reaches a module through a re-export barrel.
 *
 *     covered-root/page.tsx
 *        -> bridge/index.ts          (export * from '../outside/Unsafe')
 *        -> outside/Unsafe.tsx
 *
 * `roots: ['./src']`, so `bridge/` and `outside/` are outside every declared
 * root. `Unsafe.tsx` must still be analysed: reaching it through a re-export is
 * not a way out of the policy.
 */
export { Panel } from '../bridge/index';
