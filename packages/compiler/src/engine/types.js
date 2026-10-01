/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * PandamStyle-owned types for the retained atomic and ordering contract.
 *
 * @flow strict
 */

export type RawValue = number | string | $ReadOnlyArray<number | string>;
export type StyleValue = null | RawValue;
// These names are retained at the internal type boundary for migrated rule
// tables. Their definitions and ownership are PandamStyle's.
export type TStyleValue = StyleValue;
export type TRawValue = RawValue;
export type NestedStyleValue = StyleValue | PrimitiveStyles;
export type RawStyles = $ReadOnly<{ [string]: NestedStyleValue }>;
export type PrimitiveStyles = $ReadOnly<{ [string]: NestedStyleValue }>;

export type InjectableStyle = {
  +priority: number,
  +ltr: string,
  +rtl: null | string,
};

export type StyleRule = [string, string, InjectableStyle];
export type CompiledStyles = $ReadOnly<{
  [string]: null | string | $ReadOnly<{ [string]: null | string }>,
}>;
export type FlatCompiledStyles = $ReadOnly<{
  [string]: string | null,
  $$css: true | string,
}>;

export type EngineOptions = $ReadOnly<{
  classNamePrefix?: string,
  debug?: ?boolean,
  enableFontSizePxToRem?: ?boolean,
  enableLegacyValueFlipping?: ?boolean,
  enableLogicalStylesPolyfill?: ?boolean,
  enableMediaQueryOrder?: ?boolean,
  enableMinifiedKeys?: ?boolean,
  propertyValidationMode?: 'throw' | 'warn' | 'silent',
  styleResolution?:
    | 'application-order'
    | 'property-specificity'
    | 'legacy-expand-shorthands',
  useCSSLayers?: boolean,
  enableLTRRTLComments?: boolean,
  legacyDisableLayers?: boolean,
  useLegacyClassnamesSort?: boolean,
  __pmsCount?: ?(name: string) => void,
  __pmsPerfPhase?: <T>(name: string, work: () => T) => T,
  ...
}>;
