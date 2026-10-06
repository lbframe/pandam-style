/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - conformance policy (D-12/D-13, P0-02).
 * Property -> strict category table; finite structural domains.
 * A property not covered fails in the closed profile;
 * composite shorthands are rejected (PMS_UNSUPPORTED_PROPERTY_FORM).
 */

// Composite shorthands refused in P0.
const COMPOSITE_FORMS = new Set([
  'background',
  'border',
  'font',
  'animation',
  'transition',
]);

// Strict categories: only TokenRefs of that category are admitted.
const PROPERTY_CATEGORY = {
  // Couleurs
  color: 'colors',
  backgroundColor: 'colors',
  borderColor: 'colors',
  borderTopColor: 'colors',
  borderRightColor: 'colors',
  borderBottomColor: 'colors',
  borderLeftColor: 'colors',
  borderInlineColor: 'colors',
  borderBlockColor: 'colors',
  outlineColor: 'colors',
  textDecorationColor: 'colors',
  caretColor: 'colors',
  fill: 'colors',
  stroke: 'colors',
  // Espacement
  padding: 'spacing',
  paddingTop: 'spacing',
  paddingRight: 'spacing',
  paddingBottom: 'spacing',
  paddingLeft: 'spacing',
  paddingInline: 'spacing',
  paddingInlineStart: 'spacing',
  paddingInlineEnd: 'spacing',
  paddingBlock: 'spacing',
  paddingBlockStart: 'spacing',
  paddingBlockEnd: 'spacing',
  margin: 'spacing',
  marginTop: 'spacing',
  marginRight: 'spacing',
  marginBottom: 'spacing',
  marginLeft: 'spacing',
  marginInlineStart: 'spacing',
  marginInlineEnd: 'spacing',
  marginBlock: 'spacing',
  marginBlockStart: 'spacing',
  marginBlockEnd: 'spacing',
  top: 'spacing',
  right: 'spacing',
  bottom: 'spacing',
  left: 'spacing',
  insetInlineStart: 'spacing',
  insetInlineEnd: 'spacing',
  insetBlockStart: 'spacing',
  insetBlockEnd: 'spacing',
  textUnderlineOffset: 'spacing',
  gap: 'spacing',
  rowGap: 'spacing',
  columnGap: 'spacing',
  // Rayons
  borderRadius: 'radii',
  borderTopLeftRadius: 'radii',
  borderTopRightRadius: 'radii',
  borderBottomLeftRadius: 'radii',
  borderBottomRightRadius: 'radii',
  borderStartStartRadius: 'radii',
  borderStartEndRadius: 'radii',
  borderEndStartRadius: 'radii',
  borderEndEndRadius: 'radii',
  // Typographie
  fontFamily: 'fontFamilies',
  fontSize: 'fontSizes',
  fontWeight: 'fontWeights',
  lineHeight: 'lineHeights',
  letterSpacing: 'letterSpacings',
  // Ombres
  boxShadow: 'shadows',
  textShadow: 'shadows',
  // Mouvement
  transitionDuration: 'durations',
  transitionDelay: 'durations',
  transitionTimingFunction: 'easings',
  animationDuration: 'durations',
  animationDelay: 'durations',
  animationTimingFunction: 'easings',
};

// Admitted structural values (D-13): defined pairs/domains, not a
// blanket "numbers are allowed" rule.
const STRUCTURAL = {
  // Finite equal-track grid domain used by the constrained grid pattern.
  gridTemplateColumns: new Set(
    [1, 2, 3, 4, 5, 6].map((columns) => `repeat(${columns}, minmax(0, 1fr))`),
  ),
  display: new Set([
    'flex',
    'inline-flex',
    'block',
    'inline-block',
    'grid',
    'none',
  ]),
  flexDirection: new Set(['row', 'row-reverse', 'column', 'column-reverse']),
  alignItems: new Set([
    'flex-start',
    'flex-end',
    'center',
    'baseline',
    'stretch',
  ]),
  justifyContent: new Set([
    'flex-start',
    'flex-end',
    'center',
    'space-between',
    'space-around',
  ]),
  boxSizing: new Set(['border-box']),
  width: new Set([
    '100%',
    'fit-content',
    '1px',
    '16px',
    '20px',
    '24px',
    '28px',
    '32px',
    '36px',
    '40px',
  ]),
  height: new Set([
    '16px',
    '20px',
    '24px',
    '28px',
    '32px',
    '36px',
    '40px',
    '1px',
    '100%',
  ]),
  minWidth: new Set([
    '0',
    '16px',
    '20px',
    '24px',
    '28px',
    '32px',
    '36px',
    '40px',
    '100%',
  ]),
  maxWidth: new Set(['100%', '240px', '320px']),
  position: new Set(['relative', 'absolute']),
  inset: new Set(['0']),
  overflow: new Set(['hidden']),
  clipPath: new Set(['inset(50%)']),
  userSelect: new Set(['none']),
  whiteSpace: new Set(['nowrap']),
  backgroundClip: new Set(['padding-box']),
  borderWidth: new Set(['1px']),
  borderStyle: new Set(['solid']),
  pointerEvents: new Set(['none']),
  filter: new Set(['grayscale(1)']),
  transform: new Set(['translateY(1px)']),
  textAlign: new Set(['left', 'start']),
  textDecorationLine: new Set(['underline']),
  animationName: new Set(['spin', 'pulse']),
  animationIterationCount: new Set(['infinite']),
  alignSelf: new Set(['flex-start']),
  transitionProperty: new Set(['all']),
  marginInline: new Set(['auto']),
};

const STRUCTURAL_NUMBER_RANGES = {
  opacity: { min: 0, max: 1 },
  flex: { min: 0, max: Infinity },
  flexGrow: { min: 0, max: Infinity },
  flexShrink: { min: 0, max: Infinity },
};

export function propertyKind(property) {
  if (COMPOSITE_FORMS.has(property)) return 'composite-form';
  if (PROPERTY_CATEGORY[property] != null) return 'category';
  if (STRUCTURAL[property] != null) return 'structural-set';
  if (STRUCTURAL_NUMBER_RANGES[property] != null) return 'structural-number';
  return 'unsupported';
}

export function propertyCategory(property) {
  return PROPERTY_CATEGORY[property] ?? null;
}

export function structuralAllowed(property, value) {
  const set = STRUCTURAL[property];
  if (set != null) {
    // CSS treats the numeric zero accepted by style-object APIs as the same
    // structural value as the explicit CSS string `"0"`.
    return set.has(value) || (value === 0 && set.has('0'));
  }
  const range = STRUCTURAL_NUMBER_RANGES[property];
  if (range != null) {
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= range.min &&
      value <= range.max
    );
  }
  return false;
}

export function structuralDomain(property) {
  const set = STRUCTURAL[property];
  if (set != null) return [...set];
  if (STRUCTURAL_NUMBER_RANGES[property] != null) {
    return [
      `number in [${STRUCTURAL_NUMBER_RANGES[property].min}, ${STRUCTURAL_NUMBER_RANGES[property].max}]`,
    ];
  }
  return [];
}

export function supportedProperties() {
  return Object.freeze({
    categories: { ...PROPERTY_CATEGORY },
    structuralSets: Object.fromEntries(
      Object.entries(STRUCTURAL).map(([k, v]) => [k, [...v]]),
    ),
    structuralNumbers: { ...STRUCTURAL_NUMBER_RANGES },
    compositeFormsRejected: [...COMPOSITE_FORMS],
  });
}
