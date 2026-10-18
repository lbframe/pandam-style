import { create, token, props } from '../../.pandamstyle/design.pandamstyle.js';

const styles = create({
  title: { fontSize: token('fontSizes.heading'), fontWeight: token('fontWeights.strong') },
  text: { color: token('colors.ink'), fontSize: token('fontSizes.heading') },
});

export default function SettingsPage() {
  return (
    <section data-testid="settings">
      <h1 {...props(styles.title)}>Settings</h1>
      <p {...props(styles.text)}>Alert routing is managed by the on-call team.</p>
    </section>
  );
}
