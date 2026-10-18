import './globals.css';
import { SiteNav } from '../components/SiteNav';

export const metadata = { title: 'Docs' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SiteNav />
        <main className="prose">{children}</main>
      </body>
    </html>
  );
}
