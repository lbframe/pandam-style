// Ledger design system (systemId ledger@2). Owned by the platform design team.
import { token } from '@pandamstyle/compiler/config';

export default {
  systemId: 'ledger@2',
  tokens: {
    spacing: {
      '0': { value: '0', visibility: 'public' },
      '1': { value: '4px', visibility: 'public' },
      '2': { value: '8px', visibility: 'public' },
      '3': { value: '12px', visibility: 'public' },
      '4': { value: '16px', visibility: 'public' },
      '6': { value: '24px', visibility: 'public' },
    },
    radii: {
      control: { value: '6px', visibility: 'public' },
      panel: { value: '12px', visibility: 'public' },
    },
    colors: {
      white: { value: '#ffffff', visibility: 'private' },
      black: { value: '#000000', visibility: 'private' },
      gray50: { value: '#f8fafc', visibility: 'private' },
      gray200: { value: '#e2e8f0', visibility: 'private' },
      gray500: { value: '#64748b', visibility: 'private' },
      gray800: { value: '#1e293b', visibility: 'private' },
      gray900: { value: '#0f172a', visibility: 'private' },
      teal600: { value: '#0d9488', visibility: 'private' },
      teal700: { value: '#0f766e', visibility: 'private' },
      red600: { value: '#dc2626', visibility: 'private' },
      red50: { value: '#fef2f2', visibility: 'private' },
      green600: { value: '#16a34a', visibility: 'private' },
      green50: { value: '#f0fdf4', visibility: 'private' },
      amber600: { value: '#d97706', visibility: 'private' },
      amber50: { value: '#fffbeb', visibility: 'private' },
      yellow300: { value: '#fde047', visibility: 'private' },
      bg: {
        canvas: { ref: 'colors.gray50', visibility: 'public' },
        panel: { ref: 'colors.white', visibility: 'public' },
        sunken: { ref: 'colors.gray200', visibility: 'public' },
      },
      fg: {
        default: { ref: 'colors.gray900', visibility: 'public' },
        subtle: { ref: 'colors.gray500', visibility: 'public' },
        onAccent: { ref: 'colors.white', visibility: 'public' },
      },
      accent: {
        solid: { ref: 'colors.teal600', visibility: 'public' },
        strong: { ref: 'colors.teal700', visibility: 'public' },
      },
      line: {
        default: { ref: 'colors.gray200', visibility: 'public' },
        focus: { ref: 'colors.teal600', visibility: 'public' },
      },
      feedback: {
        critical: { ref: 'colors.red600', visibility: 'public' },
        criticalSurface: { ref: 'colors.red50', visibility: 'public' },
        positive: { ref: 'colors.green600', visibility: 'public' },
        positiveSurface: { ref: 'colors.green50', visibility: 'public' },
        caution: { ref: 'colors.amber600', visibility: 'public' },
        cautionSurface: { ref: 'colors.amber50', visibility: 'public' },
      },
    },
    fontFamilies: {
      ui: { value: 'Inter, system-ui, sans-serif', visibility: 'public' },
      mono: { value: 'ui-monospace, monospace', visibility: 'public' },
    },
    fontSizes: {
      caption: { value: '12px', visibility: 'public' },
      body: { value: '14px', visibility: 'public' },
      title: { value: '18px', visibility: 'public' },
    },
    fontWeights: {
      regular: { value: '400', visibility: 'public' },
      semibold: { value: '600', visibility: 'public' },
    },
    lineHeights: { tight: { value: '1.25', visibility: 'public' }, body: { value: '1.5', visibility: 'public' } },
    durations: { quick: { value: '100ms', visibility: 'public' } },
    easings: { out: { value: 'cubic-bezier(0.2, 0, 0, 1)', visibility: 'public' } },
  },
  themes: {
    light: { tokens: {} },
    dark: {
      tokens: {
        colors: {
          bg: { canvas: { ref: 'colors.gray900' }, panel: { ref: 'colors.gray800' }, sunken: { ref: 'colors.gray900' } },
          fg: { default: { ref: 'colors.gray50' }, subtle: { ref: 'colors.gray200' } },
          line: { default: { ref: 'colors.gray500' } },
        },
      },
    },
    highContrast: {
      extends: 'dark',
      tokens: {
        colors: {
          bg: { canvas: { ref: 'colors.black' }, panel: { ref: 'colors.black' } },
          fg: { default: { ref: 'colors.white' }, subtle: { ref: 'colors.white' } },
          line: { default: { ref: 'colors.white' }, focus: { ref: 'colors.yellow300' } },
        },
      },
    },
  },
  conditions: {
    hover: ':is(:hover, [data-hover])',
    focusVisible: ':is(:focus-visible, [data-focus-visible])',
    invalid: ':is([aria-invalid="true"], [data-invalid])',
    disabled: ':is(:disabled, [aria-disabled="true"])',
    selected: ':is([aria-selected="true"], [data-state="active"])',
    md: '@media (min-width: 720px)',
    lg: '@media (min-width: 1100px)',
  },
  recipes: {
    alert: {
      slots: ['root', 'icon', 'title', 'message'],
      base: {
        root: {
          display: 'flex',
          gap: token('spacing.3'),
          padding: token('spacing.4'),
          borderRadius: token('radii.panel'),
          borderWidth: '1px',
          borderStyle: 'solid',
        },
        icon: { width: '20px', height: '20px' },
        title: { fontWeight: token('fontWeights.semibold'), fontSize: token('fontSizes.body') },
        message: { fontSize: token('fontSizes.body'), lineHeight: token('lineHeights.body') },
      },
      variants: {
        tone: {
          info: { root: { borderColor: token('colors.line.default') } },
          critical: { root: { borderColor: token('colors.feedback.critical') }, icon: { color: token('colors.feedback.critical') } },
          positive: { root: { borderColor: token('colors.feedback.positive') }, icon: { color: token('colors.feedback.positive') } },
          caution: { root: { borderColor: token('colors.feedback.caution') }, icon: { color: token('colors.feedback.caution') } },
        },
        emphasis: {
          subtle: { root: { backgroundColor: token('colors.bg.panel') } },
          strong: { title: { color: token('colors.fg.onAccent') }, message: { color: token('colors.fg.onAccent') } },
        },
      },
      defaultVariants: { tone: 'info', emphasis: 'subtle' },
      compoundVariants: [
        { tone: 'critical', emphasis: 'strong', css: { root: { backgroundColor: token('colors.feedback.critical') }, icon: { color: token('colors.fg.onAccent') } } },
        { tone: 'positive', emphasis: 'strong', css: { root: { backgroundColor: token('colors.feedback.positive') }, icon: { color: token('colors.fg.onAccent') } } },
        { tone: ['info', 'caution'], emphasis: 'strong', css: { root: { backgroundColor: token('colors.accent.solid') }, icon: { color: token('colors.fg.onAccent') } } },
      ],
    },
    field: {
      slots: ['root', 'label', 'input', 'hint'],
      base: {
        root: { display: 'flex', flexDirection: 'column', gap: token('spacing.1') },
        label: { fontSize: token('fontSizes.caption'), fontWeight: token('fontWeights.semibold'), color: token('colors.fg.default') },
        input: {
          paddingBlock: token('spacing.2'),
          paddingInline: token('spacing.3'),
          borderRadius: token('radii.control'),
          borderWidth: '1px',
          borderStyle: 'solid',
          borderColor: token('colors.line.default'),
          backgroundColor: token('colors.bg.panel'),
          color: token('colors.fg.default'),
          fontFamily: token('fontFamilies.ui'),
          fontSize: token('fontSizes.body'),
          _focusVisible: { outlineColor: token('colors.line.focus') },
          _invalid: { borderColor: token('colors.feedback.critical') },
          _disabled: { opacity: 0.6 },
        },
        hint: { fontSize: token('fontSizes.caption'), color: token('colors.fg.subtle') },
      },
      variants: {
        size: {
          compact: { input: { paddingBlock: token('spacing.1') } },
          regular: {},
        },
      },
      defaultVariants: { size: 'regular' },
    },
    tab: {
      base: {
        display: 'inline-flex',
        paddingBlock: token('spacing.2'),
        paddingInline: token('spacing.3'),
        color: token('colors.fg.subtle'),
        fontWeight: token('fontWeights.regular'),
        _selected: { color: token('colors.accent.strong'), fontWeight: token('fontWeights.semibold') },
        _hover: { color: token('colors.fg.default') },
      },
      variants: {},
    },
  },
};
