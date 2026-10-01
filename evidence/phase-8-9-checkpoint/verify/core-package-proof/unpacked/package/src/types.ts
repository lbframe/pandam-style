/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

export type AbiVersion = 1;

export type StyleEntry = readonly [
  conflictKey: string,
  className: string | null,
];

export type StyleRef = Readonly<{
  kind: 'pandamstyle-style-ref';
  abiVersion: AbiVersion;
  systemId: string;
  entries: readonly StyleEntry[];
}>;

export type ThemeRef = Readonly<{
  kind: 'pandamstyle-theme-ref';
  abiVersion: AbiVersion;
  systemId: string;
  themeId: string;
  entries: readonly StyleEntry[];
}>;

declare const tokenRefBrand: unique symbol;
export type TokenRef<
  Category extends string = string,
  Path extends string = string,
> = Readonly<{
  kind: 'pandamstyle-token-ref';
  abiVersion: AbiVersion;
  systemId: string;
  path: Path;
  category: Category;
  [tokenRefBrand]: true;
}>;

export type RecipeSpec = Readonly<{
  abiVersion: AbiVersion;
  systemId: string;
  recipeId: string;
  axisOrder: readonly string[];
  variantMap: Readonly<Record<string, readonly string[]>>;
  defaultVariants: Readonly<Record<string, string | boolean>>;
  base: StyleRef;
  branches: Readonly<Record<string, Readonly<Record<string, StyleRef>>>>;
}>;

export type RecipeSelection = Readonly<
  Record<string, string | number | boolean | null | undefined>
>;

export type RecipeRef = ((_selection?: RecipeSelection | null) => StyleRef) &
  Readonly<{
    recipeId: string;
    axisOrder: readonly string[];
    variantMap: Readonly<Record<string, readonly string[]>>;
    variantKeys: readonly string[];
    defaultVariants: Readonly<Record<string, string | boolean>>;
    splitVariantProps(
      _props?: Readonly<Record<string, unknown>>,
    ): readonly [
      Readonly<Record<string, unknown>>,
      Readonly<Record<string, unknown>>,
    ];
    getVariantProps(
      _selection?: RecipeSelection | null,
    ): Readonly<Record<string, string | boolean>>;
  }>;

export type CompositionInput =
  | StyleRef
  | ThemeRef
  | readonly CompositionInput[]
  | null
  | undefined
  | false;

export type CompositionProps =
  | Readonly<{ className: string }>
  | Readonly<Record<string, never>>;

export type DesignSystemIdentity = Readonly<{
  systemId: string;
  registryDigest: string;
}>;

export type GeneratedIdentity = Readonly<{
  abiVersion: AbiVersion;
  compilerContractVersion: 'pms-0.1';
  designSystem: DesignSystemIdentity;
  manifestSchemaVersion: 1;
  capabilities: Readonly<{
    slots: boolean;
    compoundVariants: boolean;
    patterns: boolean;
    rawDynamicStyles: false;
  }>;
}>;

export type PmsRuntimeDiagnostic = Readonly<{
  schemaVersion: 1;
  code: string;
  severity: 'error';
  phase: 'runtime-selection';
  rule: string | null;
  context: Readonly<Record<string, unknown>>;
  expected: Readonly<Record<string, unknown>> | null;
  candidates: readonly unknown[];
  candidatesTotal: number;
  candidatesTruncated: false;
  repair: Readonly<{
    kind: string;
    applicable: boolean;
    target: Readonly<Record<string, unknown>> | null;
    expected: Readonly<Record<string, unknown>> | null;
    reason: string | null;
  }>;
  autofix: null;
  source: null;
  role: null;
  revision: null;
  message: string;
}>;

export declare class PmsSelectionError extends Error {
  constructor(
    _options: Readonly<{
      code: string;
      message?: string;
      rule?: string | null;
      context?: Readonly<Record<string, unknown>>;
      expected?: Readonly<Record<string, unknown>> | null;
      candidates?: readonly unknown[];
      repair?: PmsRuntimeDiagnostic['repair'];
    }>,
  );
  readonly schemaVersion: 1;
  readonly code: string;
  readonly severity: 'error';
  readonly phase: 'runtime-selection';
  readonly rule: string | null;
  readonly context: Readonly<Record<string, unknown>>;
  readonly expected: Readonly<Record<string, unknown>> | null;
  readonly candidates: readonly unknown[];
  readonly candidatesTotal: number;
  readonly candidatesTruncated: false;
  readonly repair: PmsRuntimeDiagnostic['repair'];
  readonly autofix: null;
  readonly source: null;
  readonly role: null;
  readonly revision: null;
  readonly diagnostic: PmsRuntimeDiagnostic;
}

export declare const ABI_VERSION: AbiVersion;
export declare function assertAbi(_version: number): AbiVersion;
export declare function props(
  ..._inputs: readonly CompositionInput[]
): CompositionProps;
export declare function defineRecipeSelector(_spec: RecipeSpec): RecipeRef;
