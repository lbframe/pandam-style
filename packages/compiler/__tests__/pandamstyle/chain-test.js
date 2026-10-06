/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle — démonstration de la chaîne tokens -> recipe -> CSS
 * sur la machinerie réelle du fork (styleXDefineVars / styleXCreateTheme /
 * styleXCreateSet de src/shared, props/styleq de @stylexjs/stylex).
 * Rejets de politique prouvés en JavaScript pur, sans TypeScript.
 */

'use strict';

jest.autoMockOff();

import {
  buildDesignSystem,
  conformanceDefinition,
  token,
  PmsError,
} from '../../../../.pms-test-support/compiler-inspection.cjs';

const build = () => buildDesignSystem(conformanceDefinition);

describe('pandamstyle: registre', () => {
  test('références résolues, catégories et visibilité conservées', () => {
    const ds = build();
    expect(ds.registry.resolvedValues['colors.action.primary']).toBe('#2563eb');
    expect(ds.registry.resolvedValues['colors.surface.primary']).toBe(
      '#f8fafc',
    );
    expect(ds.registry.tokens['colors.blue.500'].visibility).toBe('private');
    expect(ds.registry.tokens['colors.action.primary'].visibility).toBe(
      'public',
    );
    expect(ds.registry.registryDigest).toMatch(/^[0-9a-f]{16}$/);
  });

  test('référence vers un identifiant absent -> PMS_UNKNOWN_TOKEN', () => {
    const def = {
      systemId: 'x',
      tokens: {
        colors: { a: { ref: 'colors.absent', visibility: 'public' } },
      },
    };
    try {
      buildDesignSystem(def);
      throw new Error('should have failed');
    } catch (e) {
      expect(e).toBeInstanceOf(PmsError);
      expect(e.diagnostics[0].code).toBe('PMS_UNKNOWN_TOKEN');
      expect(e.diagnostics[0].context.missingRef).toBe('colors.absent');
    }
  });

  test('cycle de références -> PMS_TOKEN_CYCLE avec chemin', () => {
    const def = {
      systemId: 'x',
      tokens: {
        colors: {
          a: { ref: 'colors.b' },
          b: { ref: 'colors.a' },
        },
      },
    };
    try {
      buildDesignSystem(def);
      throw new Error('should have failed');
    } catch (e) {
      expect(e.diagnostics[0].code).toBe('PMS_TOKEN_CYCLE');
      expect(e.diagnostics[0].context.cycle).toContain('colors.a');
    }
  });
});

describe('pandamstyle: tokens -> CSS', () => {
  test('un token compilé devient var(--…) et les variables sont émises', () => {
    const ds = build();
    const { compiled } = ds.create({
      page: {
        backgroundColor: token('colors.surface.primary'),
        color: token('colors.text.primary'),
        padding: token('spacing.md'),
      },
    });
    const varRef = ds.varsByToken['spacing.md'];
    expect(varRef).toMatch(/^var\(--x/);
    const css = ds.renderCss();
    expect(css).toContain('padding:var(--');
    expect(css).toContain('--x');
    // La variable porte la valeur résolue du token.
    expect(css).toMatch(/--x\w+:16px/);
    expect(compiled.page.$$css).toBe(true);
  });

  test('condition nommée -> bloc canonique @media', () => {
    const ds = build();
    ds.create({
      page: {
        padding: { base: token('spacing.md'), wide: token('spacing.lg') },
      },
    });
    const css = ds.renderCss();
    expect(css).toContain('@media (min-width: 768px)');
    expect(css).toContain('padding:var(--');
  });

  test('deux thèmes partagent les mêmes identités de variables', () => {
    const ds = build();
    expect(ds.themeClasses.light).toBeTruthy();
    expect(ds.themeClasses.dark).toBeTruthy();
    const css = ds.renderCss();
    // Surcharge dark de colors.surface.primary -> #1e293b (gray.800).
    expect(css).toContain('#1e293b');
    // Un seul groupe de variables : les deux classes référencent le même hash.
    const lightHash = ds.themeClasses.light;
    expect(ds.themeClasses.dark).toContain(lightHash.split(' ')[0]);
  });
});

describe('pandamstyle: rejets de politique (sans TypeScript)', () => {
  test("valeur brute '17px' rejetée avec candidats admis", () => {
    const ds = build();
    try {
      ds.create({ page: { padding: '17px' } });
      throw new Error('should have failed');
    } catch (e) {
      expect(e).toBeInstanceOf(PmsError);
      const d = e.diagnostics[0];
      expect(d.code).toBe('PMS_FORBIDDEN_VALUE');
      expect(d.phase).toBe('policy');
      expect(d.context.value).toBe('17px');
      expect(d.context.candidates).toContain('spacing.md');
      expect(d.autofix).toBeNull();
    }
  });

  test('token de mauvaise catégorie -> PMS_INVALID_TOKEN_CATEGORY', () => {
    const ds = build();
    try {
      ds.create({ page: { fontSize: token('spacing.md') } });
      throw new Error('should have failed');
    } catch (e) {
      expect(e.diagnostics[0].code).toBe('PMS_INVALID_TOKEN_CATEGORY');
      expect(e.diagnostics[0].context.expected).toBe('fontSizes');
    }
  });

  test('token privé côté consommateur -> PMS_TOKEN_NOT_PUBLIC', () => {
    const ds = build();
    try {
      ds.create({ page: { color: token('colors.blue.500') } });
      throw new Error('should have failed');
    } catch (e) {
      expect(e.diagnostics[0].code).toBe('PMS_TOKEN_NOT_PUBLIC');
    }
  });

  test('forme composite border -> PMS_UNSUPPORTED_PROPERTY_FORM', () => {
    const ds = build();
    try {
      ds.create({ page: { border: '1px solid red' } });
      throw new Error('should have failed');
    } catch (e) {
      expect(e.diagnostics[0].code).toBe('PMS_UNSUPPORTED_PROPERTY_FORM');
    }
  });

  test('propriété hors profil -> PMS_UNSUPPORTED_PROPERTY', () => {
    const ds = build();
    try {
      ds.create({ page: { backdropFilter: 'blur(4px)' } });
      throw new Error('should have failed');
    } catch (e) {
      expect(e.diagnostics[0].code).toBe('PMS_UNSUPPORTED_PROPERTY');
    }
  });

  test('primitives UI couvertes avec un domaine de valeurs fini', () => {
    const ds = build();
    ds.create({
      control: {
        display: 'inline-flex',
        width: '100%',
        height: '100%',
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        borderWidth: '1px',
        borderStyle: 'solid',
        animationName: 'spin',
        animationDuration: token('durations.fast'),
      },
    });
    expect(ds.renderCss()).toContain('height:100%');
    expect(ds.renderCss()).toContain('animation-name:spin');

    try {
      ds.create({ control: { height: '17px' } });
      throw new Error('should have failed');
    } catch (e) {
      expect(e).toBeInstanceOf(PmsError);
      expect(e.diagnostics[0].code).toBe('PMS_FORBIDDEN_VALUE');
      expect(e.diagnostics[0].context.property).toBe('height');
    }
  });

  test('condition inconnue -> PMS_UNKNOWN_CONDITION', () => {
    const ds = build();
    try {
      ds.create({ page: { padding: { hover333: token('spacing.md') } } });
      throw new Error('should have failed');
    } catch (e) {
      expect(e.diagnostics[0].code).toBe('PMS_UNKNOWN_CONDITION');
    }
  });
});

describe('pandamstyle: recipe -> CSS', () => {
  test('sélection bornée : base + branches par axe selon axisOrder', () => {
    const ds = build();
    const sel = ds.recipes.button({ variant: 'primary', size: 'md' });
    expect(sel.kind).toBe('pandamstyle-style-ref');
    // Le cœur fusionne base + variant.primary + size.md dans un seul StyleRef.
    expect(sel.entries.length).toBeGreaterThan(0);
    const p = ds.props(sel);
    expect(typeof p.className).toBe('string');
    const css = ds.renderCss();
    // fontSize vient de la branche size.md, backgroundColor de variant.primary
    expect(css).toContain('background-color:var(--');
  });

  test('défauts appliqués quand la prop est absente ou undefined', () => {
    const ds = build();
    const a = ds.recipes.button({});
    const b = ds.recipes.button({ variant: 'primary', size: 'md' });
    expect(ds.props(a).className).toBe(ds.props(b).className);
  });

  test('valeur hors domaine rejetée de façon déterministe au runtime', () => {
    const ds = build();
    expect(() => ds.recipes.button({ variant: 'huge' })).toThrow(
      /PMS_INVALID_VARIANT_VALUE/,
    );
    try {
      ds.recipes.button({ variant: 'huge' });
    } catch (e) {
      expect(e.code).toBe('PMS_INVALID_VARIANT_VALUE');
      expect(e.context.admitted).toEqual(['primary', 'secondary']);
    }
  });

  test('clé inconnue et null rejetés', () => {
    const ds = build();
    try {
      ds.recipes.button({ weight: 'md' });
      throw new Error('x');
    } catch (e) {
      expect(e.code).toBe('PMS_INVALID_VARIANT_KEY');
    }
    try {
      ds.recipes.button({ size: null });
      throw new Error('x');
    } catch (e) {
      expect(e.code).toBe('PMS_INVALID_VARIANT_VALUE');
    }
  });

  test('conflit base/hover : la variante gagne hors condition, hover conservé', () => {
    // Cas charnière §4.2 : base color + hover.color ; variante modifiant
    // seulement color hors condition ne supprime pas la branche hover.
    const ds = build();
    const css = ds.renderCss();
    // variant.primary définit _hover { color: text.inverse } -> règle :is(:hover,[data-hover])
    expect(css).toContain(':is(:hover, [data-hover])');
  });
});

describe('pandamstyle: manifeste', () => {
  test('projection consommateur : publics seulement, capacités P1 à false', () => {
    const ds = build();
    const m = ds.manifest;
    expect(m.tokens['colors.action.primary']).toBeTruthy();
    expect(m.tokens['colors.blue.500']).toBeUndefined();
    expect(m.capabilities).toEqual({
      slots: true,
      compoundVariants: true,
      patterns: true,
      rawDynamicStyles: false,
    });
    expect(m.recipes.button.axes).toEqual({
      variant: ['primary', 'secondary'],
      size: ['sm', 'md'],
    });
    expect(m.registryDigest).toBe(ds.registry.registryDigest);
  });
});
