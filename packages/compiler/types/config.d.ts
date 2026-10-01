import type { Definition } from './index.js';

export type TokenRef<Path extends string = string> = Readonly<{
  readonly __pandamstyleAuthorToken: unique symbol;
  readonly path: Path;
}>;

export function token<const Path extends string>(path: Path): TokenRef<Path>;
export function defineConfig<const T extends Definition>(config: T): T;
