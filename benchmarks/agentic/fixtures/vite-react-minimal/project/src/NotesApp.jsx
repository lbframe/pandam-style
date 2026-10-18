import { create, token, props, themes } from '../pandamstyle/generated/design.pandamstyle.js';
import { NoteList } from './components/NoteList.jsx';
import { Toolbar } from './components/Toolbar.jsx';

const styles = create({
  app: {
    backgroundColor: token('colors.surface.base'),
    color: token('colors.text.primary'),
    padding: token('spacing.md'),
  },
});

const notes = [
  { id: 'n1', title: 'Groceries', body: 'Oat milk, lemons, rice.' },
  { id: 'n2', title: 'Ideas', body: 'Weekly review template.' },
];

export function NotesApp() {
  return (
    <div data-testid="notes-app" {...props(themes.light, styles.app)}>
      <Toolbar />
      <NoteList notes={notes} />
    </div>
  );
}
