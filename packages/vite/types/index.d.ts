import type { Definition, ProjectConfig } from '@pandamstyle/compiler';
import type { Plugin } from 'vite';

export type PandamStyleOptions = Omit<
  ProjectConfig,
  'rootDir' | 'definition' | 'acceptedSnapshotRetention'
> & {
  /** Design-system definition or a module path relative to Vite's resolved root. */
  readonly definition: Definition | string;
  /** Source roots that contain all app-local PandamStyle authoring modules. */
  readonly roots: readonly string[];
};

/** Create a Vite plugin backed by one canonical PandamStyle Project Service. */
export declare function pandamstyle(options: PandamStyleOptions): Plugin;

export default pandamstyle;
