import type { Metadata } from 'next';
import Link from 'next/link';
import {
  countCompletedOrders,
  countCompletedOrdersToday,
  countUniqueCustomers,
  getPublicTop50,
  listStorefront,
  listTestimonials,
} from '@levelup/db';
import { getCustomerSession } from '../lib/customer-session';
import { getDb } from '../lib/server';
import { diamonds, initials, mxn, roundDownSignificant } from '../lib/format';
import { avatarUrl, flyerUrl } from '../lib/assets';
import { socialLinks } from '../lib/social';
import logo from '../assets/logo.webp';
import mascotThumbs from '../assets/mascot/thumbs.webp';
import mascotMegaphone from '../assets/mascot/mascot-megaphone.png';
import mascotIdle from '../assets/mascot/idle.webp';
import chestDiamonds from '../assets/mascot/chest-diamonds.png';
import giftBox from '../assets/mascot/gift-box.png';
import {
  BellIcon,
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
import { CountUp, DigitTiles } from './count-up';
import { HeroScene } from './hero-scene';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { alternates: { canonical: '/' } };

const WHY_US = [
  {
    icon: BoltIcon,
    tone: 'purple',
    title: 'Recargas automáticas',
    text: 'Diamantes directo a tu cuenta. Sin esperar, sin complicaciones.',
  },
  {
    icon: ShieldIcon,
    tone: 'cyan',
    title: 'Pago 100% seguro',
    text: 'Métodos de pago confiables. Tu compra protegida.',
  },
  {
    icon: InfinityIcon,
    tone: 'green',
    title: 'Garantía de por vida',
    text: 'Nuestros diamantes son libres de baneo o reembolso.',
  },
  {
    icon: HeadsetIcon,
    tone: 'pink',
    title: 'Soporte LevelUp',
    text: 'Estamos contigo antes y después de tu recarga.',
  },
] as const;

const FLYER_SLOTS = [
  ['descuentos', 'chidos'],
  ['super_pack', 'super pack'],
  ['energia', 'insana'],
  ['mega_prime', 'megaprime', 'packs_mega'],
] as const;

type Campaign = Awaited<ReturnType<typeof listStorefront>>[number];

function assignFlyerSlots(campaigns: Campaign[], featuredKey: string | null): Campaign[] {
  const rest = campaigns.filter((c) => c.key !== featuredKey);
  const used = new Set<string>();
  const slots: (Campaign | null)[] = [null, null, null, null];

  FLYER_SLOTS.forEach((needles, i) => {
    const found = rest.find(
      (c) =>
        !used.has(c.key) &&
        needles.some((n) => c.key.includes(n.replace(' ', '_')) || c.name.toLowerCase().includes(n)),
    );
    if (found) {
      slots[i] = found;
      used.add(found.key);
    }
  });

  for (const campaign of rest) {
    const empty = slots.indexOf(null);
    if (empty === -1) break;
    if (!used.has(campaign.key)) {
      slots[empty] = campaign;
      used.add(campaign.key);
    }
  }

  return slots.filter((c): c is Campaign => c !== null);
}

export default async function HomePage() {
  const [campaigns, delivered, customers, today, top50, testimonials, session] = await Promise.all([
    listStorefront(getDb()),
    countCompletedOrders(getDb()),
    countUniqueCustomers(getDb()),
    countCompletedOrdersToday(getDb()),
    getPublicTop50(getDb()),
    listTestimonials(getDb()),
    getCustomerSession(),
  ]);

  const rated = testimonials.filter((t) => t.rating);
  const avgRating =
    rated.length >= 3 ? rated.reduce((sum, t) => t.rating! + sum, 0) / rated.length : null;

  const packs = campaigns.flatMap((campaign) => campaign.combos.map((combo) => ({ campaign, combo })));
  const featured =
    packs.find((p) => p.combo.advertisedDiamonds === 110) ??
    packs.find((p) => p.campaign.permanent) ??
    packs[0] ??
    null;

  const social = socialLinks();
  const hasSocial = social.facebook || social.instagram || social.tiktok;
  const top3 = top50.rows.slice(0, 3);
  const rail = assignFlyerSlots(campaigns, featured?.campaign.key ?? null);
  const liveCount = today > 0 ? today : delivered;
  const liveCountIsToday = today > 0;
  const showLive = liveCount > 0 || customers > 0 || avgRating;

  return (
    <main className="page hm">
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
          <span className="hm-bar-user hm-bar-bell" aria-hidden="true">
            <BellIcon className="icon" />
            <span className="hm-bar-bell-dot" />
          </span>
          <Link href="/cuenta" className="hm-bar-user" aria-label={session ? 'Mi cuenta' : 'Crear mi cuenta'}>
            <UserIcon className="icon" />
          </Link>
        </div>
      </header>

      {top3.length > 0 && (
        <Link href="/ranking" className="hm-season">
          <div className="hm-season-label">
            <CrownIcon className="icon" />
            <span>
              Temporada {top50.season?.seasonNumber ?? 1}
              <em>Top de jugadores</em>
            </span>
          </div>
          <div className="hm-season-players">
            {top3.map((player) => {
              const name = player.displayName ?? 'Jugador';
              const url = avatarUrl(player.avatarAssetUrl);
              return (
                <div key={player.playerProfileId} className={`hm-season-player hm-season-r${player.rank}`}>
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
                </div>
              );
            })}
          </div>
          <span className="hm-season-more">Ver tabla completa →</span>
        </Link>
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
            <span className="hm-hero-cta">
              <CartIcon className="icon" />
              Comprar ahora →
            </span>
          </div>
          <div className="hm-hero-art" aria-hidden="true">
            <img className="hm-hero-chest" src={chestDiamonds.src} alt="" decoding="async" />
            <img className="hm-hero-mascot" src={mascotThumbs.src} alt="" decoding="async" />
            <p className="hm-hero-aside">Más diamantes, más victorias</p>
          </div>
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

      {showLive && (
        <section className="hm-live" aria-label="Actividad en vivo">
          <span className="hm-live-pill">
            <span className="hm-live-dot" aria-hidden="true" />
            En vivo
          </span>
          {liveCount > 0 && (
            <div className="hm-live-stat">
              <strong>
                <CountUp value={liveCount} tiles padDigits={4} />
              </strong>
              <span>{liveCountIsToday ? 'recargas hoy' : 'recargas'}</span>
            </div>
          )}
          {avgRating && (
            <div className="hm-live-stat hm-live-rating">
              <strong>★ {avgRating.toFixed(1)}</strong>
              <span>valoración</span>
            </div>
          )}
          {customers > 0 && (
            <div className="hm-live-stat">
              <strong>
                <DigitTiles text={`+${roundDownSignificant(customers).toLocaleString('es-MX')}`} />
              </strong>
              <span>clientes satisfechos</span>
            </div>
          )}
          <img className="hm-live-mascot" src={mascotIdle.src} alt="" decoding="async" />
        </section>
      )}

      {rail.length > 0 && (
        <>
          <div className="hm-ofertas-head">
            <h2>Ofertas disponibles</h2>
            <Link href="/promociones" className="hm-ofertas-more">
              Ver más
            </Link>
          </div>
          <div className="hm-ofertas">
            {rail.map((campaign) => {
              const flyer = flyerUrl(campaign.flyerAssetUrl);
              return (
                <Link key={campaign.key} href={`/promocion/${campaign.key}`} className="hm-offer">
                  {flyer ? (
                    <img className="hm-offer-flyer" src={flyer} alt={campaign.name} decoding="async" />
                  ) : (
                    <div className="hm-offer-flyer hm-offer-empty">{campaign.name}</div>
                  )}
                </Link>
              );
            })}
          </div>
        </>
      )}

      {campaigns.length === 0 && (
        <div className="card empty">Estamos preparando las promociones del mes. Vuelve pronto.</div>
      )}

      <section>
        <h2 className="section-title-lg center">
          ¿Por qué elegir <span className="grad">LevelUp Store</span>?
        </h2>
        <div className="why-grid">
          {WHY_US.map(({ icon: Icon, tone, title, text }) => (
            <div key={title} className={`card why-item glow-${tone}`}>
              <div className={`trust-icon ${tone}`}>
                <Icon className="icon" />
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
