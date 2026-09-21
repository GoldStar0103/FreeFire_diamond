import type { Metadata, Viewport } from 'next';
import { googleSiteVerification } from '../lib/google-verification';
import { siteOrigin } from '../lib/site';
import { metaPixelId, tiktokPixelId } from '../lib/pixel-ids';
import { MetaPixel } from './meta-pixel';
import { TikTokPixel } from './tiktok-pixel';
import { BottomNav } from './bottom-nav';
import { WhatsappChannelPopup } from './whatsapp-channel-popup';
import { whatsappChannelUrl } from '../lib/whatsapp-channel';
import logo from '../assets/logo.webp';
import './globals.css';

const DESCRIPTION =
  'Recargas de diamantes para Free Fire directo a tu cuenta. Entrega automática, pago seguro.';

/**
 * Per request, because `metadataBase` and the Search Console token both come
 * from the environment. A prerendered layout would bake in whatever the image
 * was built with — including an empty verification tag — and no restart would
 * fix it. Same trap as the sitemap and the legal pages.
 */
export const dynamic = 'force-dynamic';

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
export async function generateMetadata(): Promise<Metadata> {
  const google = googleSiteVerification();

  return {
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
    ...(google ? { verification: { google } } : {}),
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
}

// Traffic is almost entirely phones arriving from TikTok, Instagram and
// WhatsApp, so the mobile viewport is the design target, not an afterthought.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0d0f1a',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Each pixel is on only when its ID is configured and passes validation —
  // see lib/pixel-ids.ts for why that check is a security boundary.
  const metaId = metaPixelId();
  const tiktokId = tiktokPixelId();
  const channelUrl = whatsappChannelUrl();

  return (
    <html lang="es-MX">
      <body>
        {metaId && <MetaPixel pixelId={metaId} />}
        {tiktokId && <TikTokPixel pixelId={tiktokId} />}
        {channelUrl && <WhatsappChannelPopup channelUrl={channelUrl} />}
        {children}
        <footer className="site-footer">
          {/* The logo on every page, not just the home hero: a buyer who lands
              straight on a shared /comprar link should still see whose store
              this is. Decorative here — the name sits right beside it. */}
          <div className="footer-brand">
            <img
              src={logo.src}
              width={36}
              height={36}
              alt=""
              loading="lazy"
              decoding="async"
            />
            <span>LEVELUP STORE</span>
          </div>
          <div className="footer-links">
            <a href="/">Inicio</a>
            <a href="/pedidos">Mis pedidos</a>
            <a href="/confianza">Confianza</a>
            {/* A real page now (see /soporte) rather than jumping straight to
                WhatsApp — the client's own complaint was that support offered
                nothing but a redirect. WhatsApp is still the fastest way to
                actually reach someone; it is one tap away on that page. */}
            <a href="/soporte">Soporte</a>
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
        <BottomNav />
      </body>
    </html>
  );
}
