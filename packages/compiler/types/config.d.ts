import type { Definition } from './index.js';

export type TokenRef<Path extends string = string> = Readonly<{
  readonly __pandamstyleAuthorToken: unique symbol;
  readonly path: Path;
}>;

export type PatternResponsive<Value> =
  | Value
  | Readonly<Partial<Record<string, Value>>>;
export type PatternSpacingValue = TokenRef<`spacing.${string}`>;
export type PatternAlignValue =
  | 'start'
  | 'end'
  | 'center'
  | 'stretch'
  | 'baseline';
export type PatternJustifyValue =
  | 'start'
  | 'end'
  | 'center'
  | 'between'
  | 'around';
export type PatternColumnCount = 1 | 2 | 3 | 4 | 5 | 6;

export interface PatternStylesParameters {
  readonly stack: Readonly<{
    gap?: PatternResponsive<PatternSpacingValue>;
    align?: PatternResponsive<PatternAlignValue>;
    justify?: PatternResponsive<PatternJustifyValue>;
  }>;
  readonly inline: PatternStylesParameters['stack'];
  readonly center: Readonly<{ inline?: boolean }>;
  readonly grid: Readonly<{
    columns?: PatternResponsive<PatternColumnCount>;
    gap?: PatternResponsive<PatternSpacingValue>;
    align?: PatternResponsive<PatternAlignValue>;
  }>;
  readonly box: Readonly<{
    padding?: PatternResponsive<PatternSpacingValue>;
    paddingInline?: PatternResponsive<PatternSpacingValue>;
    paddingBlock?: PatternResponsive<PatternSpacingValue>;
  }>;
}

export type PatternStylesId = keyof PatternStylesParameters;

export function token<const Path extends string>(path: Path): TokenRef<Path>;
export function patternStyles<Pattern extends PatternStylesId>(
  patternId: Pattern,
  parameters?: PatternStylesParameters[Pattern],
): Readonly<Record<string, unknown>>;
export function defineConfig<const T extends Definition>(config: T): T;
