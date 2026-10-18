import { create, token, props, themes } from '../.pandamstyle/design.pandamstyle.js';
import { ProductPage } from './pages/ProductPage.jsx';

const styles = create({
  shell: {
    backgroundColor: token('colors.surface.page'),
    color: token('colors.text.primary'),
    fontFamily: token('fontFamilies.base'),
  },
});

export function App({ theme = 'light' }) {
  return (
    <div data-testid="app-shell" {...props(themes.light, styles.shell)}>
      <ProductPage />
    </div>
  );
}
