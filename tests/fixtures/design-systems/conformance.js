/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - the "conformance" fixture (P0 section 6).
 * Teaching values: this is not a theme shipped to users.
 * Private color primitives, public semantic colors, public spacing.
 */

import { token } from '../../../packages/compiler/src/design-system/tokens/ref';

export const conformanceDefinition = {
  systemId: 'conformance@0.1',
  tokens: {
    spacing: {
      zero: { value: '0', visibility: 'public' },
      xs: { value: '4px', visibility: 'public' },
      sm: { value: '8px', visibility: 'public' },
      md: { value: '16px', visibility: 'public' },
      lg: { value: '24px', visibility: 'public' },
      xl: { value: '32px', visibility: 'public' },
    },
    radii: {
      sm: { value: '2px', visibility: 'public' },
      md: { value: '6px', visibility: 'public' },
      lg: { value: '12px', visibility: 'public' },
    },
    colors: {
      blue: { '500': { value: '#2563eb', visibility: 'private' } },
      'blue.600': { value: '#1d4ed8', visibility: 'private' },
      red: { '500': { value: '#dc2626', visibility: 'private' } },
      gray: {
        '50': { value: '#f8fafc', visibility: 'private' },
        '100': { value: '#e2e8f0', visibility: 'private' },
        '800': { value: '#1e293b', visibility: 'private' },
        '900': { value: '#0f172a', visibility: 'private' },
      },
      white: { value: '#ffffff', visibility: 'private' },
      surface: {
        primary: { ref: 'colors.gray.50', visibility: 'public' },
      },
      text: {
        primary: { ref: 'colors.gray.900', visibility: 'public' },
        inverse: { ref: 'colors.white', visibility: 'public' },
      },
      action: {
        primary: { ref: 'colors.blue.500', visibility: 'public' },
        primaryHover: { ref: 'colors.blue.600', visibility: 'public' },
      },
    },
    fontFamilies: {
      base: { value: 'system-ui, sans-serif', visibility: 'public' },
      mono: { value: 'ui-monospace, monospace', visibility: 'public' },
    },
    fontSizes: {
      sm: { value: '14px', visibility: 'public' },
      md: { value: '16px', visibility: 'public' },
      lg: { value: '20px', visibility: 'public' },
    },
    fontWeights: {
      normal: { value: '400', visibility: 'public' },
      bold: { value: '700', visibility: 'public' },
    },
    lineHeights: {
      normal: { value: '1.5', visibility: 'public' },
      tight: { value: '1.25', visibility: 'public' },
    },
    letterSpacings: {
      normal: { value: '0', visibility: 'public' },
      wide: { value: '0.02em', visibility: 'public' },
    },
    shadows: {
      card: { value: '0 2px 8px rgba(0, 0, 0, 0.12)', visibility: 'public' },
    },
    durations: {
      fast: { value: '120ms', visibility: 'public' },
      normal: { value: '200ms', visibility: 'public' },
    },
    easings: {
      standard: { value: 'ease-in-out', visibility: 'public' },
    },
  },
  themes: {
    light: { tokens: {} },
    dark: {
      tokens: {
        colors: {
          surface: { primary: { ref: 'colors.gray.800' } },
          text: { primary: { ref: 'colors.gray.100' } },
          action: {
            primary: { ref: 'colors.blue.500' },
            primaryHover: { ref: 'colors.blue.500' },
          },
        },
      },
    },
  },
  conditions: {
    hover: ':is(:hover, [data-hover])',
    disabled: ':is(:disabled, [data-disabled], [aria-disabled="true"])',
    wide: '@media (min-width: 768px)',
    reducedMotion: '@media (prefers-reduced-motion: reduce)',
  },
  recipes: {
    button: {
      base: {
        display: 'inline-flex',
        alignItems: 'center',
        fontFamily: token('fontFamilies.base'),
        fontWeight: token('fontWeights.bold'),
        borderRadius: token('radii.md'),
        transitionDuration: token('durations.fast'),
      },
      variants: {
        variant: {
          primary: {
            color: token('colors.text.inverse'),
            backgroundColor: token('colors.action.primary'),
            _hover: { color: token('colors.text.inverse') },
          },
          secondary: {
            color: token('colors.text.primary'),
            backgroundColor: token('colors.gray.100'),
          },
        },
        size: {
          sm: { fontSize: token('fontSizes.sm'), padding: token('spacing.sm') },
          md: { fontSize: token('fontSizes.md'), padding: token('spacing.md') },
        },
      },
      defaultVariants: { variant: 'primary', size: 'md' },
    },
  },
};
