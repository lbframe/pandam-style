import { create, token, props, recipes } from '../../pandamstyle/generated/design.pandamstyle.js';

const styles = create({
  bar: { display: 'flex', gap: token('spacing.sm'), marginBottom: token('spacing.md') },
});

export function Toolbar() {
  return (
    <div data-testid="toolbar" {...props(styles.bar)}>
      <button type="button" data-testid="new-note" {...props(recipes.button({ tone: 'primary' }))}>
        New note
      </button>
    </div>
  );
}
