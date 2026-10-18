import { props, recipes } from '../.pandamstyle/design.pandamstyle.js';

const links = [
  { href: '/', label: 'Overview' },
  { href: '/settings', label: 'Settings' },
];

export function Sidebar({ current, collapsed = false }) {
  const nav = recipes.nav({ collapsed });
  return (
    <nav data-testid="sidebar" {...props(nav.root)}>
      <ul {...props(nav.list)}>
        {links.map((link) => (
          <li key={link.href}>
            <a
              href={link.href}
              data-testid={`nav-${link.label.toLowerCase()}`}
              aria-current={link.href === current ? 'page' : undefined}
              {...props(nav.link)}
            >
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
