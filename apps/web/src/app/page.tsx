import type { Metadata } from 'next';
import { Orbitron, Rajdhani } from 'next/font/google';
import Link from 'next/link';
import { getPublicTop50, listStorefront } from '@levelup/db';
import { getCustomerSession } from '../lib/customer-session';
import { getDb } from '../lib/server';
import { loadHomeActivity } from '../lib/home-activity';
import { loadAccountNotices } from '../lib/account-notices';
import { diamonds, initials, mxn } from '../lib/format';
import { avatarUrl, flyerUrl } from '../lib/assets';
import { socialLinks } from '../lib/social';
import logo from '../assets/logo.webp';
import mascotThumbs from '../assets/mascot/thumbs.webp';
import mascotMegaphone from '../assets/mascot/mascot-megaphone.png';
import chestDiamonds from '../assets/mascot/chest-diamonds.png';
import giftBox from '../assets/mascot/gift-box.png';
import mascotWink from '../assets/mascot/wink.webp';
import mascotIdle from '../assets/mascot/idle.webp';
import mascotHug from '../assets/mascot/hug-diamond.webp';
import mascotWave from '../assets/mascot/wave.webp';
import {
  BoltIcon,
  CartIcon,
  CrownIcon,
  DiamondIcon,
  FacebookIcon,
  HeadsetIcon,
  InfinityIcon,
  InstagramIcon,
  ShieldIcon,
  TikTokIcon,
  UserIcon,
} from './icons';
import { HowItWorks } from './how-it-works';
import { HeroScene } from './hero-scene';
import { LiveMetrics } from './live-metrics';
import { NotificationBell } from './notifications';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { alternates: { canonical: '/' } };

const display = Orbitron({
  subsets: ['latin'],
  weight: ['700', '800', '900'],
  variable: '--font-display',
  display: 'swap',
});
const ui = Rajdhani({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-ui',
  display: 'swap',
});

const WHY_US = [
  {
    icon: BoltIcon,
    tone: 'purple',
    mascot: mascotWink,
    title: 'Recargas automáticas',
    text: 'Diamantes directo a tu cuenta cuando la entrega queda confirmada.',
  },
  {
    icon: ShieldIcon,
    tone: 'cyan',
    mascot: mascotIdle,
    title: 'Pago 100% seguro',
    text: 'Métodos de pago confiables. Tu compra protegida.',
  },
  {
    icon: InfinityIcon,
    tone: 'green',
    mascot: mascotHug,
    title: 'Garantía de por vida',
    text: 'Si una recarga entregada falla, la revisamos hasta dejarla resuelta.',
  },
  {
    icon: HeadsetIcon,
    tone: 'pink',
    mascot: mascotWave,
    title: 'Soporte LevelUp',
    text: 'Estamos contigo antes y después de tu recarga.',
  },
] as const;

type Ranked = Awaited<ReturnType<typeof getPublicTop50>>['rows'][number];

/** Second, first, third — the approved ribbon, not rank order left to right. */
function podiumOrder(rows: Ranked[]): Ranked[] {
  const top = [...rows].sort((a, b) => a.rank - b.rank).slice(0, 3);
  if (top.length < 2) return top;
  if (top.length === 2) return [top[1]!, top[0]!];
  return [top[1]!, top[0]!, top[2]!];
}

export default async function HomePage() {
  const db = getDb();
  const [campaigns, top50, session, activity] = await Promise.all([
    listStorefront(db),
    getPublicTop50(db),
    getCustomerSession(),
    loadHomeActivity(),
  ]);
  const notices = session ? await loadAccountNotices(session.playerProfileId, session.playerId) : [];

  const packs = campaigns.flatMap((campaign) => campaign.combos.map((combo) => ({ campaign, combo })));
  const featured =
    packs.find((p) => p.combo.advertisedDiamonds === 110) ??
    packs.find((p) => p.campaign.permanent) ??
    packs[0] ??
    null;

  const social = socialLinks();
  const hasSocial = social.facebook || social.instagram || social.tiktok;
  const podium = podiumOrder(top50.rows);
  const rail = campaigns.slice(0, 4);

  return (
    <main className={`page hm ${display.variable} ${ui.variable}`}>
      <header className="hm-bar">
        <div className="hm-bar-side hm-bar-social">
          {hasSocial && (
            <div className="social-links">
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
          )}
        </div>
        <div className="hm-bar-brand">
          <img src={logo.src} width={44} height={44} alt="" decoding="async" />
          <div className="hm-bar-wordmark">
            <span className="hm-bar-name">
              LEVELUP <span className="grad">STORE</span>
            </span>
            <span className="hm-bar-place">MÉXICO</span>
          </div>
        </div>
        <div className="hm-bar-side hm-bar-account">
          <NotificationBell signedIn={Boolean(session)} notices={notices} />
          <Link href="/cuenta" className="hm-bar-user" aria-label={session ? 'Mi cuenta' : 'Crear mi cuenta'}>
            <UserIcon className="icon" />
          </Link>
        </div>
      </header>

      {top50.season && (
        <section className="hm-season" aria-label="Top de jugadores">
          <Link href="/ranking" className="hm-season-label">
            <CrownIcon className="icon" />
            <span>
              Temporada {top50.season.seasonNumber}
              <em>Top de jugadores</em>
            </span>
          </Link>
          <div className="hm-season-players">
            {podium.length === 0 && (
              <span className="hm-season-empty">Aún no hay jugadores en esta temporada.</span>
            )}
            {podium.map((player) => {
              const name = player.displayName ?? 'Jugador';
              const url = avatarUrl(player.avatarAssetUrl);
              return (
                <Link
                  key={player.playerProfileId}
                  href={`/jugador/${player.playerProfileId}`}
                  className={`hm-season-player hm-season-r${player.rank}`}
                >
                  <span className="hm-season-rank" aria-hidden="true">
                    {player.rank}
                  </span>
                  {url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={url} alt="" width={28} height={28} />
                  ) : (
                    <div className="avatar" aria-hidden="true">
                      {initials(name)}
                    </div>
                  )}
                  <span className="hm-season-name">{name}</span>
                  <span className="hm-season-diamonds">
                    <DiamondIcon className="icon" />
                    {diamonds(player.seasonalDiamonds)}
                  </span>
                </Link>
              );
            })}
          </div>
          <Link href="/ranking" className="hm-season-more">
            Ver tabla completa →
          </Link>
        </section>
      )}

      {featured && (
        <Link href={`/comprar/${featured.combo.key}`} className="hm-hero">
          <HeroScene />
          <div className="hm-hero-copy">
            <div className="hm-hero-kicker">
              <BoltIcon className="icon" />
              Oferta especial
            </div>
            <div className="hm-hero-pack">
              <span className="hm-hero-num grad">{diamonds(featured.combo.advertisedDiamonds)}</span>
              <span className="hm-hero-unit">diamantes</span>
            </div>
            <div className="hm-hero-price">× {mxn(featured.combo.priceMxnCents)}</div>
            <ul className="hm-hero-chips">
              <li>
                <BoltIcon className="icon" />
                Entrega inmediata
              </li>
              <li>
                <ShieldIcon className="icon" />
                Pago seguro
              </li>
              <li>
                <DiamondIcon className="icon" />
                Mejor precio
              </li>
            </ul>
          </div>
          <div className="hm-hero-art" aria-hidden="true">
            <img className="hm-hero-chest" src={chestDiamonds.src} alt="" decoding="async" />
            <img className="hm-hero-mascot" src={mascotThumbs.src} alt="" decoding="async" />
          </div>
          <span className="hm-hero-cta">
            <CartIcon className="icon" />
            Comprar ahora →
          </span>
        </Link>
      )}

      <Link href="/promociones" className="hm-promo">
        <div className="hm-promo-art" aria-hidden="true">
          <div className="hx-mascot-glow" />
          <img className="hm-promo-mascot" src={mascotMegaphone.src} alt="" decoding="async" />
        </div>
        <div className="hm-promo-copy">
          <h2>
            Promociones
            <span>nuevas</span>
            todos los meses
          </h2>
          <span className="hm-promo-cta">Ver ofertas →</span>
        </div>
        <img className="hm-promo-gift" src={giftBox.src} alt="" decoding="async" />
      </Link>

      <LiveMetrics initial={activity} />

      <div className="hm-ofertas-head">
        <h2>Ofertas disponibles</h2>
        <Link href="/promociones" className="hm-ofertas-more">
          Ver más
        </Link>
      </div>
      {rail.length > 0 ? (
        <div className="hm-ofertas">
          {rail.map((campaign) => {
            const flyer = flyerUrl(campaign.flyerAssetUrl);
            return (
              <Link key={campaign.key} href={`/promocion/${campaign.key}`} className="hm-offer">
                {flyer ? (
                  <img className="hm-offer-flyer" src={flyer} alt={campaign.name} decoding="async" loading="lazy" />
                ) : (
                  <div className="hm-offer-flyer hm-offer-empty">{campaign.name}</div>
                )}
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="card empty">Estamos preparando las promociones del mes. Vuelve pronto.</div>
      )}

      <section className="hm-why">
        <div className="hm-section-head">
          <h2 className="section-title-lg">
            ¿Por qué elegir <span className="grad">LevelUp Store</span>?
          </h2>
          <div className="hm-callout">
            <span className="hm-bubble">¡Siempre contigo!</span>
            <img src={mascotThumbs.src} alt="" width={88} height={96} decoding="async" loading="lazy" />
          </div>
        </div>
        <div className="why-grid">
          {WHY_US.map(({ icon: Icon, tone, mascot, title, text }) => (
            <div key={title} className={`card why-item glow-${tone}`}>
              <div className="why-item-top">
                <div className={`trust-icon ${tone}`}>
                  <Icon className="icon" />
                </div>
                <img className="why-mascot" src={mascot.src} alt="" decoding="async" loading="lazy" />
              </div>
              <h3>{title}</h3>
              <p>{text}</p>
            </div>
          ))}
        </div>
      </section>

      <HowItWorks />
    </main>
  );
}
