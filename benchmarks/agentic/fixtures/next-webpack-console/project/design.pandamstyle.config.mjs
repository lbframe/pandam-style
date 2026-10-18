// Ops console design system. Changes go through the design-system review.
import { token } from '@pandamstyle/compiler/config';

export default {
  systemId: 'ops-console@3',
  tokens: {
    spacing: {
      tight: { value: '6px', visibility: 'public' },
      base: { value: '12px', visibility: 'public' },
      loose: { value: '20px', visibility: 'public' },
      section: { value: '32px', visibility: 'public' },
    },
    radii: { soft: { value: '6px', visibility: 'public' }, round: { value: '9999px', visibility: 'public' } },
    colors: {
      slate950: { value: '#020617', visibility: 'private' },
      slate700: { value: '#334155', visibility: 'private' },
      slate400: { value: '#94a3b8', visibility: 'private' },
      slate100: { value: '#f1f5f9', visibility: 'private' },
      white: { value: '#ffffff', visibility: 'private' },
      violet600: { value: '#7c3aed', visibility: 'private' },
      emerald600: { value: '#059669', visibility: 'private' },
      rose600: { value: '#e11d48', visibility: 'private' },
      page: { ref: 'colors.slate100', visibility: 'public' },
      sidebar: { ref: 'colors.slate950', visibility: 'public' },
      sidebarText: { ref: 'colors.slate400', visibility: 'public' },
      sidebarActive: { ref: 'colors.white', visibility: 'public' },
      ink: { ref: 'colors.slate950', visibility: 'public' },
      inkMuted: { ref: 'colors.slate700', visibility: 'public' },
      brand: { ref: 'colors.violet600', visibility: 'public' },
      healthy: { ref: 'colors.emerald600', visibility: 'public' },
      failing: { ref: 'colors.rose600', visibility: 'public' },
      onStatus: { ref: 'colors.white', visibility: 'public' },
    },
    fontFamilies: { sans: { value: 'system-ui, sans-serif', visibility: 'public' } },
    fontSizes: { small: { value: '13px', visibility: 'public' }, normal: { value: '15px', visibility: 'public' }, heading: { value: '22px', visibility: 'public' } },
    fontWeights: { normal: { value: '400', visibility: 'public' }, strong: { value: '650', visibility: 'public' } },
  },
  themes: {
    standard: { tokens: {} },
    operator: {
      tokens: {
        colors: {
          page: { ref: 'colors.slate950' },
          ink: { ref: 'colors.slate100' },
          inkMuted: { ref: 'colors.slate400' },
        },
      },
    },
  },
  conditions: {
    hover: ':is(:hover, [data-hover])',
    current: ':is([aria-current="page"])',
    desktop: '@media (min-width: 1024px)',
  },
  recipes: {
    nav: {
      slots: ['root', 'list', 'link'],
      base: {
        root: { display: 'flex', flexDirection: 'column', backgroundColor: token('colors.sidebar'), padding: token('spacing.loose') },
        list: { display: 'flex', flexDirection: 'column', gap: token('spacing.tight') },
        link: {
          display: 'block',
          paddingBlock: token('spacing.tight'),
          paddingInline: token('spacing.base'),
          borderRadius: token('radii.soft'),
          color: token('colors.sidebarText'),
          fontSize: token('fontSizes.normal'),
          _hover: { color: token('colors.sidebarActive') },
          _current: { color: token('colors.sidebarActive'), fontWeight: token('fontWeights.strong') },
        },
      },
      variants: {
        collapsed: {
          true: { root: { paddingInline: token('spacing.tight') }, link: { paddingInline: token('spacing.tight') } },
          false: {},
        },
      },
      defaultVariants: { collapsed: false },
    },
    pill: {
      base: {
        display: 'inline-flex',
        paddingInline: token('spacing.base'),
        borderRadius: token('radii.round'),
        fontSize: token('fontSizes.small'),
        fontWeight: token('fontWeights.strong'),
        color: token('colors.onStatus'),
      },
      variants: {
        health: {
          healthy: { backgroundColor: token('colors.healthy') },
          failing: { backgroundColor: token('colors.failing') },
        },
        muted: {
          true: { opacity: 0.6 },
          false: {},
        },
      },
      defaultVariants: { health: 'healthy', muted: false },
    },
  },
};
