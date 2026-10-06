import type {
  Definition,
  DiagnosticsResult,
  ProjectConfig,
} from '@pandamstyle/compiler';
import type { NextConfig } from 'next';

export interface PandamStyleNextEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

type PandamStyleNextBaseOptions = Omit<
  ProjectConfig,
  'rootDir' | 'definition'
> & {
  readonly definition: Definition | string;
  readonly roots: readonly string[];
  /**
   * Explicit React Compiler qualification. Currently only supports Next
   * 16.3.8 with React/ReactDOM 19.3.0 and `reactCompiler: true`.
   */
  readonly reactCompilerQualification?: 'next-16.3.8-react-19.3.0';
  /** Structured Diagnostics Protocol v1 observations. */
  readonly onDiagnostics?: (result: DiagnosticsResult) => void;
  /** Host lifecycle/counter observations; does not authorize publication. */
  readonly onEvent?: (event: PandamStyleNextEvent) => void;
};

export type PandamStyleNextOptions = PandamStyleNextBaseOptions &
  (
    | { readonly backend: 'webpack'; readonly publicationMode?: 'strict' }
    | {
        readonly backend: 'turbopack';
        readonly publicationMode: 'semantic-dev' | 'strict';
      }
  );

export type PandamStyleNextConfig =
  | NextConfig
  | ((
      phase: string,
      context: { defaultConfig: NextConfig },
    ) => NextConfig | Promise<NextConfig>);

/** Configure a Next CLI host. No application runtime import is supported. */
export declare function withPandamStyle(
  options: PandamStyleNextOptions,
): (
  config?: PandamStyleNextConfig,
) => (
  phase: string,
  context: { defaultConfig: NextConfig },
) => Promise<NextConfig>;
