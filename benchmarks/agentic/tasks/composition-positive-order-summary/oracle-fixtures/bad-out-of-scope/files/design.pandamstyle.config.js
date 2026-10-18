// Storefront design system. This file is the only source of design vocabulary.
// Changing it is a design-system change and requires explicit authorization.
import { token } from '@pandamstyle/compiler/config';

export default {
  systemId: 'storefront@1',
  tokens: {
    spacing: {
      none: { value: '0', visibility: 'public' },
      xs: { value: '4px', visibility: 'public' },
      sm: { value: '8px', visibility: 'public' },
      md: { value: '16px', visibility: 'public' },
      lg: { value: '24px', visibility: 'public' },
      xl: { value: '32px', visibility: 'public' },
      xxl: { value: '48px', visibility: 'public' },
    },
    radii: {
      sm: { value: '4px', visibility: 'public' },
      md: { value: '8px', visibility: 'public' },
      pill: { value: '999px', visibility: 'public' },
    },
    colors: {
      ink900: { value: '#111827', visibility: 'private' },
      ink600: { value: '#4b5563', visibility: 'private' },
      paper: { value: '#ffffff', visibility: 'private' },
      mist: { value: '#f3f4f6', visibility: 'private' },
      night: { value: '#0b1220', visibility: 'private' },
      nightRaised: { value: '#1f2937', visibility: 'private' },
      brand500: { value: '#2563eb', visibility: 'private' },
      brand600: { value: '#1d4ed8', visibility: 'private' },
      danger500: { value: '#dc2626', visibility: 'private' },
      danger600: { value: '#b91c1c', visibility: 'private' },
      success500: { value: '#16a34a', visibility: 'private' },
      amber500: { value: '#d97706', visibility: 'private' },
      surface: {
        page: { ref: 'colors.paper', visibility: 'public' },
        raised: { ref: 'colors.mist', visibility: 'public' },
      },
      text: {
        primary: { ref: 'colors.ink900', visibility: 'public' },
        muted: { ref: 'colors.ink600', visibility: 'public' },
        inverse: { ref: 'colors.paper', visibility: 'public' },
      },
      action: {
        primary: { ref: 'colors.brand500', visibility: 'public' },
        primaryHover: { ref: 'colors.brand600', visibility: 'public' },
        danger: { ref: 'colors.danger500', visibility: 'public' },
        dangerHover: { ref: 'colors.danger600', visibility: 'public' },
      },
      status: {
        success: { ref: 'colors.success500', visibility: 'public' },
        danger: { ref: 'colors.danger500', visibility: 'public' },
      },
      border: {
        subtle: { ref: 'colors.mist', visibility: 'public' },
      },
    },
    fontFamilies: {
      base: { value: 'system-ui, sans-serif', visibility: 'public' },
    },
    fontSizes: {
      sm: { value: '14px', visibility: 'public' },
      md: { value: '16px', visibility: 'public' },
      lg: { value: '20px', visibility: 'public' },
    },
    fontWeights: {
      regular: { value: '400', visibility: 'public' },
      bold: { value: '700', visibility: 'public' },
    },
    lineHeights: {
      normal: { value: '1.5', visibility: 'public' },
    },
    shadows: {
      raised: { value: '0 2px 8px rgba(17, 24, 39, 0.12)', visibility: 'public' },
    },
    durations: {
      fast: { value: '120ms', visibility: 'public' },
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
          surface: {
            page: { ref: 'colors.night' },
            raised: { ref: 'colors.nightRaised' },
          },
          text: {
            primary: { ref: 'colors.paper' },
            muted: { ref: 'colors.mist' },
          },
          border: { subtle: { ref: 'colors.nightRaised' } },
        },
      },
    },
  },
  conditions: {
    hover: ':is(:hover, [data-hover])',
    focusVisible: ':is(:focus-visible, [data-focus-visible])',
    disabled: ':is(:disabled, [data-disabled], [aria-disabled="true"])',
    wide: '@media (min-width: 768px)',
  },
  recipes: {
    button: {
      base: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: token('radii.md'),
        fontFamily: token('fontFamilies.base'),
        fontWeight: token('fontWeights.bold'),
        transitionDuration: token('durations.fast'),
        transitionTimingFunction: token('easings.standard'),
        _disabled: { opacity: 0.5, pointerEvents: 'none' },
      },
      variants: {
        tone: {
          primary: {
            color: token('colors.text.inverse'),
            backgroundColor: token('colors.action.primary'),
            _hover: { backgroundColor: token('colors.action.primaryHover') },
          },
          neutral: {
            color: token('colors.text.primary'),
            backgroundColor: token('colors.surface.raised'),
          },
          danger: {
            color: token('colors.text.inverse'),
            backgroundColor: token('colors.action.danger'),
            _hover: { backgroundColor: token('colors.action.dangerHover') },
          },
        },
        size: {
          sm: {
            fontSize: token('fontSizes.sm'),
            paddingBlock: token('spacing.xs'),
            paddingInline: token('spacing.sm'),
          },
          md: {
            fontSize: token('fontSizes.md'),
            paddingBlock: token('spacing.sm'),
            paddingInline: token('spacing.md'),
          },
        },
        fullWidth: {
          true: { width: '100%' },
          false: {},
        },
      },
      defaultVariants: { tone: 'primary', size: 'md', fullWidth: false },
    },
    badge: {
      base: {
        display: 'inline-flex',
        alignItems: 'center',
        borderRadius: token('radii.pill'),
        paddingInline: token('spacing.sm'),
        fontSize: token('fontSizes.sm'),
        fontWeight: token('fontWeights.bold'),
        color: token('colors.text.inverse'),
      },
      variants: {
        status: {
          neutral: {
            color: token('colors.text.primary'),
            backgroundColor: token('colors.surface.raised'),
          },
          success: { backgroundColor: token('colors.status.success') },
          danger: { backgroundColor: token('colors.status.danger') },
        },
      },
      defaultVariants: { status: 'neutral' },
    },
    card: {
      slots: ['root', 'header', 'title', 'body', 'footer'],
      base: {
        root: {
          display: 'flex',
          flexDirection: 'column',
          borderRadius: token('radii.md'),
          backgroundColor: token('colors.surface.page'),
          color: token('colors.text.primary'),
        },
        header: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: token('spacing.md'),
        },
        title: {
          fontSize: token('fontSizes.lg'),
          fontWeight: token('fontWeights.bold'),
        },
        body: {
          paddingInline: token('spacing.md'),
          color: token('colors.text.muted'),
          lineHeight: token('lineHeights.normal'),
        },
        footer: {
          display: 'flex',
          justifyContent: 'flex-end',
          gap: token('spacing.sm'),
          padding: token('spacing.md'),
        },
      },
      variants: {
        elevation: {
          flat: {
            root: {
              borderWidth: '1px',
              borderStyle: 'solid',
              borderColor: token('colors.border.subtle'),
            },
          },
          raised: { root: { boxShadow: token('shadows.raised') } },
        },
        density: {
          comfortable: {},
          compact: {
            header: { padding: token('spacing.sm') },
            footer: { padding: token('spacing.sm') },
          },
        },
      },
      defaultVariants: { elevation: 'flat', density: 'comfortable' },
      compoundVariants: [
        {
          elevation: 'raised',
          density: 'compact',
          css: { root: { borderRadius: token('radii.sm') } },
        },
      ],
    },
  },
};
