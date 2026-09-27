/**
 * PandamStyle — politique de conformité (D-12/D-13, P0-02).
 * Table propriété -> catégorie stricte ; domaines structurels finis.
 * Une propriété non couverte échoue dans le profil fermé ;
 * les raccourcis composites sont rejetés (PMS_UNSUPPORTED_PROPERTY_FORM).
 */

// Raccourcis composites refusés en P0.
const COMPOSITE_FORMS = new Set([
  'background',
  'border',
  'font',
  'animation',
  'transition',
]);

// Catégories strictes : seules les TokenRef de la catégorie sont admises.
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

// Valeurs structurelles admises (D-13) : paires/domaines définis, pas une
// règle globale "les nombres sont autorisés".
const STRUCTURAL = {
  display: new Set(['flex', 'inline-flex', 'block', 'inline-block', 'grid', 'none']),
  flexDirection: new Set(['row', 'row-reverse', 'column', 'column-reverse']),
  alignItems: new Set(['flex-start', 'flex-end', 'center', 'baseline', 'stretch']),
  justifyContent: new Set([
    'flex-start',
    'flex-end',
    'center',
    'space-between',
    'space-around',
  ]),
  boxSizing: new Set(['border-box']),
  width: new Set(['100%']),
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
  if (set != null) return set.has(value);
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
    return [`number in [${STRUCTURAL_NUMBER_RANGES[property].min}, ${STRUCTURAL_NUMBER_RANGES[property].max}]`];
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
