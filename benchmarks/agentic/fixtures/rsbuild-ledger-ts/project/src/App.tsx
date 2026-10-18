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

export function App() {
  return (
    <div data-testid="ledger-app" {...props(themes.light, styles.canvas)}>
      <AccountsRoute />
    </div>
  );
}
