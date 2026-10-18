import { create, token, props, themes } from '../.pandamstyle/design.pandamstyle.js';
import { AccountsRoute } from './routes/AccountsRoute';

const styles = create({
  canvas: {
    backgroundColor: token('colors.bg.canvas'),
    color: token('colors.fg.default'),
    fontFamily: token('fontFamilies.ui'),
    padding: { base: token('spacing.4'), lg: token('spacing.6') },
  },
});

type ThemeName = 'light' | 'dark' | 'highContrast';

export function App({ theme = 'light' }: { theme?: ThemeName }) {
  return (
    <div data-testid="ledger-app" {...props(theme === 'dark' ? themes.dark : theme === 'highContrast' ? themes.highContrast : themes.light, styles.canvas)}>
      <AccountsRoute />
    </div>
  );
}
