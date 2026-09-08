import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'LevelUp Store — Panel',
  description: 'Panel de administración de recargas',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-MX">
      <body>{children}</body>
    </html>
  );
}
