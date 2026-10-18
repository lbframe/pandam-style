// Travel portal design system. Token values mirror the legacy CSS variables
// one-to-one so migrated components render identically.
import { token } from '@pandamstyle/compiler/config';

export default {
  systemId: 'travel@4',
  tokens: {
    spacing: {
      s2: { value: '8px', visibility: 'public' },
      s3: { value: '12px', visibility: 'public' },
      s4: { value: '16px', visibility: 'public' },
      s6: { value: '24px', visibility: 'public' },
    },
    radii: { card: { value: '10px', visibility: 'public' }, chip: { value: '999px', visibility: 'public' } },
    colors: {
      navy: { value: '#0b2545', visibility: 'private' },
      sand: { value: '#f4ede4', visibility: 'private' },
      coral: { value: '#ef6f6c', visibility: 'private' },
      white: { value: '#ffffff', visibility: 'private' },
      text: { strong: { ref: 'colors.navy', visibility: 'public' } },
      surface: { muted: { ref: 'colors.sand', visibility: 'public' }, card: { ref: 'colors.white', visibility: 'public' } },
      highlight: { ref: 'colors.coral', visibility: 'public' },
    },
    fontSizes: { sm: { value: '14px', visibility: 'public' }, md: { value: '16px', visibility: 'public' }, xl: { value: '28px', visibility: 'public' } },
    fontWeights: { bold: { value: '700', visibility: 'public' } },
  },
  themes: { default: { tokens: {} } },
  conditions: { hover: ':is(:hover, [data-hover])', wide: '@media (min-width: 900px)' },
  recipes: {
    chip: {
      base: {
        display: 'inline-flex',
        paddingInline: token('spacing.s3'),
        borderRadius: token('radii.chip'),
        fontSize: token('fontSizes.sm'),
        backgroundColor: token('colors.surface.muted'),
        color: token('colors.text.strong'),
      },
      variants: { emphasis: { normal: {}, hot: { backgroundColor: token('colors.highlight'), color: token('colors.surface.card') } } },
      defaultVariants: { emphasis: 'normal' },
    },
  },
};
