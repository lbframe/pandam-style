/**
 * Two barrels deep, both outside every declared root.
 *     src/page.tsx -> bridge/a.ts -> bridge/b.ts -> outside/Unsafe.tsx
 */
export { Panel } from '../bridge/a';
