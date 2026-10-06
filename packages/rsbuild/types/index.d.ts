import type {
  Definition,
  ProjectConfig,
  RevisionIdentity,
} from '@pandamstyle/compiler';
import type { RsbuildPlugin } from '@rsbuild/core';

export interface PandamStyleRsbuildEvent {
  readonly kind:
    | 'revision'
    | 'transform'
    | 'settled'
    | 'reload'
    | 'rejected'
    | 'closed';
  readonly revision: RevisionIdentity | null;
  readonly [key: string]: unknown;
}

export type PandamStyleRsbuildOptions = Omit<
  ProjectConfig,
  'rootDir' | 'definition' | 'acceptedSnapshotRetention'
> & {
  /** Definition value or an ESM module path relative to Rsbuild rootPath. */
  readonly definition: Definition | string;
  readonly roots: readonly string[];
  /** Pass host-loaded local modules through unchanged when the compiler has no artifact for them. */
  readonly passthroughUncovered?: boolean;
  /** Observations only. Callback failures cannot alter compiler decisions. */
  readonly onEvent?: (event: PandamStyleRsbuildEvent) => void;
};

export declare function pandamstyle(
  options: PandamStyleRsbuildOptions,
): RsbuildPlugin;
export default pandamstyle;
