import type { Metadata, Viewport } from 'next';
import { Outfit } from 'next/font/google';
import { facebookDomainVerification, googleSiteVerification } from '../lib/google-verification';
import { siteOrigin } from '../lib/site';
import { metaPixelId, tiktokPixelId } from '../lib/pixel-ids';
import { MetaPixel } from './meta-pixel';
import { TikTokPixel } from './tiktok-pixel';
import { BottomNav } from './bottom-nav';
import { WhatsappChannelPopup } from './whatsapp-channel-popup';
import { whatsappChannelUrl } from '../lib/whatsapp-channel';
import { legalIdentity, pending } from '../lib/legal';
import { socialLinks } from '../lib/social';
import { FacebookIcon, InstagramIcon, TikTokIcon } from './icons';
import logo from '../assets/logo.webp';
import './globals.css';

const outfit = Outfit({ subsets: ['latin'], display: 'swap' });

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
  const facebook = facebookDomainVerification();
  const verification = {
    ...(google ? { google } : {}),
    ...(facebook ? { other: { 'facebook-domain-verification': facebook } } : {}),
  };

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
    ...(Object.keys(verification).length > 0 ? { verification } : {}),
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
  const social = socialLinks();
  const hasSocial = social.facebook || social.instagram || social.tiktok;

  return (
    <html lang="es-MX" className={outfit.className}>
      <body>
        {metaId && <MetaPixel pixelId={metaId} />}
        {tiktokId && <TikTokPixel pixelId={tiktokId} />}
        {channelUrl && <WhatsappChannelPopup channelUrl={channelUrl} />}
        {children}
        <footer className="site-footer">
          <div className="footer-grid">
            <div className="footer-col footer-brand-col">
              <div className="footer-brand">
                <img src={logo.src} width={36} height={36} alt="" loading="lazy" decoding="async" />
                <span>LEVELUP STORE</span>
              </div>
              <p className="footer-tag">Recargas de diamantes Free Fire, directo a tu cuenta.</p>
            </div>
            <div className="footer-col">
              <h2>Navegación</h2>
              <a href="/">Inicio</a>
              <a href="/promociones">Promociones</a>
              <a href="/cuenta">Mi cuenta</a>
              <a href="/ranking">Ranking</a>
              <a href="/pedidos">Mis pedidos</a>
              <a href="/confianza">Confianza</a>
              <a href="/soporte">Soporte</a>
            </div>
            <div className="footer-col">
              <h2>Legal</h2>
              <a href="/legal/terminos">Términos y Condiciones</a>
              <a href="/legal/privacidad">Aviso de Privacidad</a>
              <p className="footer-note">Operado por {pending(legalIdentity().legalName, 'razón social')}.</p>
            </div>
            {hasSocial && (
              <div className="footer-col">
                <h2>Síguenos</h2>
                <div className="footer-social">
                  {social.tiktok && (
                    <a href={social.tiktok} target="_blank" rel="noreferrer" aria-label="TikTok">
                      <TikTokIcon className="icon" />
                    </a>
                  )}
                  {social.instagram && (
                    <a href={social.instagram} target="_blank" rel="noreferrer" aria-label="Instagram">
                      <InstagramIcon className="icon" />
                    </a>
                  )}
                  {social.facebook && (
                    <a href={social.facebook} target="_blank" rel="noreferrer" aria-label="Facebook">
                      <FacebookIcon className="icon" />
                    </a>
                  )}
                </div>
              </div>
            )}
          </div>
          <div className="footer-notes">
            <div className="footer-note">No afiliado a Garena. Free Fire es marca de sus respectivos dueños.</div>
          </div>
        </footer>
        <BottomNav />
      </body>
    </html>
  );
}
