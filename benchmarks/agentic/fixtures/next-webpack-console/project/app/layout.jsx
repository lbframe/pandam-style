import { create, token, props, themes } from '../.pandamstyle/design.pandamstyle.js';
import { Sidebar } from '../components/Sidebar.jsx';

const styles = create({
  body: {
    display: 'flex',
    backgroundColor: token('colors.page'),
    color: token('colors.ink'),
    fontFamily: token('fontFamilies.sans'),
  },
  main: { flexGrow: 1, padding: { base: token('spacing.loose'), desktop: token('spacing.section') } },
});

export const metadata = { title: 'Ops console' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body data-testid="console-body" {...props(themes.standard, styles.body)}>
        <Sidebar current="/" />
        <main data-testid="console-main" {...props(styles.main)}>
          {children}
        </main>
      </body>
    </html>
  );
}
