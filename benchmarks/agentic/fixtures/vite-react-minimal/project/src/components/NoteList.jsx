import { create, token, props } from '../../pandamstyle/generated/design.pandamstyle.js';

const styles = create({
  list: { display: 'flex', flexDirection: 'column', gap: token('spacing.sm') },
  item: { padding: token('spacing.sm'), borderRadius: token('radii.small') },
  title: { fontSize: token('fontSizes.body') },
});

export function NoteList({ notes }) {
  return (
    <ul data-testid="note-list" {...props(styles.list)}>
      {notes.map((note) => (
        <li key={note.id} data-testid={`note-${note.id}`} {...props(styles.item)}>
          <h2 {...props(styles.title)}>{note.title}</h2>
          <p>{note.body}</p>
        </li>
      ))}
    </ul>
  );
}
