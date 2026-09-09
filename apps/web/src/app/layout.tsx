import type { Metadata, Viewport } from 'next';
import { siteOrigin } from '../lib/site';
import { supportUrl } from '../lib/support';
import './globals.css';

const DESCRIPTION =
  'Recargas de diamantes para Free Fire directo a tu cuenta. Entrega automática, pago seguro.';

/**
 * Share metadata matters more here than it looks.
 *
 * Every visitor arrives from a link pasted into TikTok, Instagram or a WhatsApp
 * group. Without Open Graph tags those links preview as a bare grey box, and a
 * grey box from an unknown store is precisely the thing this market has learned
 * to scroll past. The preview card is the first trust signal, before anyone
 * reaches the site at all.
 *
 * `metadataBase` is what makes the rest work: relative og:image paths resolve
 * against it, and without it Next emits them relative, which every scraper
 * ignores.
 */
export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin()),
  title: {
    default: 'LevelUp Store — Recargas Free Fire',
    // Page titles read "Pack Insano · LevelUp Store" rather than repeating the
    // brand twice.
    template: '%s · LevelUp Store',
  },
  description: DESCRIPTION,
  applicationName: 'LevelUp Store',
  // No `alternates.canonical` here on purpose. Metadata is inherited, so a
  // canonical of '/' in the root layout would make every page that does not
  // override it declare itself to be the homepage — which tells search engines
  // to drop /confianza and both legal notices in favour of it. Each page sets
  // its own.
  openGraph: {
    type: 'website',
    siteName: 'LevelUp Store',
    locale: 'es_MX',
    title: 'LevelUp Store — Recargas Free Fire',
    description: DESCRIPTION,
    url: '/',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'LevelUp Store — Recargas Free Fire',
    description: DESCRIPTION,
  },
};

// Traffic is almost entirely phones arriving from TikTok, Instagram and
// WhatsApp, so the mobile viewport is the design target, not an afterthought.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0d0f1a',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const support = supportUrl();

  return (
    <html lang="es-MX">
      <body>
        {children}
        <footer className="site-footer">
          <div className="footer-brand">LEVELUP STORE</div>
          <div className="footer-links">
            <a href="/">Inicio</a>
            <a href="/pedidos">Mis pedidos</a>
            <a href="/confianza">Confianza</a>
            {/* Support lives here and on a failed order — never as a floating
                button. The client's market is full of curious children.
                Hidden entirely when no number is configured, rather than
                linking to `https://wa.me/`, which opens an error page. */}
            {support && (
              <a href={support} target="_blank" rel="noreferrer">
                Soporte
              </a>
            )}
          </div>
          <div className="footer-links small">
            <a href="/legal/terminos">Términos y Condiciones</a>
            <a href="/legal/privacidad">Aviso de Privacidad</a>
          </div>
          <div className="footer-note">
            No afiliado a Garena. Free Fire es marca de sus respectivos dueños.
          </div>
          <div className="footer-note">Juega más. Domina más.</div>
        </footer>
      </body>
    </html>
  );
}
