// Notes design system. Intentionally small; extend only with design approval.
import { token } from '@pandamstyle/compiler/config';

export default {
  systemId: 'notes@0.3',
  tokens: {
    spacing: {
      sm: { value: '8px', visibility: 'public' },
      md: { value: '16px', visibility: 'public' },
    },
    radii: { small: { value: '4px', visibility: 'public' } },
    colors: {
      graphite: { value: '#27272a', visibility: 'private' },
      snow: { value: '#fafafa', visibility: 'private' },
      indigo: { value: '#4f46e5', visibility: 'private' },
      crimson: { value: '#be123c', visibility: 'private' },
      text: { primary: { ref: 'colors.graphite', visibility: 'public' } },
      surface: { base: { ref: 'colors.snow', visibility: 'public' } },
      accent: { primary: { ref: 'colors.indigo', visibility: 'public' } },
      danger: { ref: 'colors.crimson', visibility: 'public' },
    },
    fontSizes: { body: { value: '15px', visibility: 'public' } },
  },
  themes: { light: { tokens: {} } },
  conditions: { hover: ':is(:hover, [data-hover])' },
  recipes: {
    button: {
      base: {
        display: 'inline-flex',
        paddingInline: token('spacing.md'),
        paddingBlock: token('spacing.sm'),
        borderRadius: token('radii.small'),
        fontSize: token('fontSizes.body'),
      },
      variants: {
        tone: {
          primary: { color: token('colors.surface.base'), backgroundColor: token('colors.accent.primary') },
          danger: { color: token('colors.surface.base'), backgroundColor: token('colors.danger') },
        },
      },
      defaultVariants: { tone: 'primary' },
    },
  },
};
