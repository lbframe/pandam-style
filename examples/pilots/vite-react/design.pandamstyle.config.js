/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Pilot design system. Educational values, not a shipped theme.
 */
import { token } from '@pandamstyle/compiler/config';

export default {
  systemId: 'pilot@0.1',
  tokens: {
    spacing: {
      zero: { value: '0', visibility: 'public' },
      sm: { value: '8px', visibility: 'public' },
      md: { value: '16px', visibility: 'public' },
      lg: { value: '24px', visibility: 'public' },
    },
    radii: {
      md: { value: '8px', visibility: 'public' },
      lg: { value: '16px', visibility: 'public' },
    },
    colors: {
      slate900: { value: '#0b1120', visibility: 'private' },
      slate100: { value: '#e2e8f0', visibility: 'private' },
      brand500: { value: '#4f46e5', visibility: 'private' },
      brand600: { value: '#4338ca', visibility: 'private' },
      surface: { base: { ref: 'colors.slate100', visibility: 'public' } },
      text: {
        primary: { ref: 'colors.slate900', visibility: 'public' },
        inverse: { ref: 'colors.slate100', visibility: 'public' },
      },
      action: {
        primary: { ref: 'colors.brand500', visibility: 'public' },
        primaryHover: { ref: 'colors.brand600', visibility: 'public' },
      },
    },
    fontFamilies: {
      base: { value: 'system-ui, sans-serif', visibility: 'public' },
    },
    fontSizes: {
      sm: { value: '14px', visibility: 'public' },
      md: { value: '16px', visibility: 'public' },
    },
    fontWeights: { bold: { value: '700', visibility: 'public' } },
    lineHeights: { normal: { value: '1.5', visibility: 'public' } },
    shadows: {
      card: { value: '0 1px 3px rgba(11,17,32,0.12)', visibility: 'public' },
    },
    durations: { fast: { value: '120ms', visibility: 'public' } },
    easings: { standard: { value: 'ease-in-out', visibility: 'public' } },
  },
  themes: {
    light: { tokens: {} },
    dark: {
      tokens: {
        colors: {
          surface: { base: { ref: 'colors.slate900' } },
          text: { primary: { ref: 'colors.slate100' } },
        },
      },
    },
  },
  conditions: {
    hover: ':is(:hover, [data-hover])',
    wide: '@media (min-width: 768px)',
  },
  recipes: {
    button: {
      base: {
        display: 'inline-flex',
        alignItems: 'center',
        borderRadius: token('radii.md'),
        padding: token('spacing.sm'),
        fontFamily: token('fontFamilies.base'),
        fontWeight: token('fontWeights.bold'),
      },
      variants: {
        tone: {
          primary: {
            color: token('colors.text.inverse'),
            backgroundColor: token('colors.action.primary'),
            _hover: { backgroundColor: token('colors.action.primaryHover') },
          },
          quiet: {
            color: token('colors.text.primary'),
            backgroundColor: token('colors.surface.base'),
          },
        },
        size: {
          sm: { fontSize: token('fontSizes.sm') },
          md: { fontSize: token('fontSizes.md'), padding: token('spacing.md') },
        },
      },
      defaultVariants: { tone: 'primary', size: 'md' },
    },
  },
};
