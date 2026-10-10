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
import mascot from '../assets/mascot.webp';
import logo from '../assets/logo.webp';
import banner1 from '../assets/banner/banner-1.webp';
import banner2 from '../assets/banner/banner-2.webp';
import banner3 from '../assets/banner/banner-3.webp';
import { BoltIcon, FacebookIcon, HeadsetIcon, InfinityIcon, InstagramIcon, ShieldIcon, TikTokIcon } from './icons';
import { BannerSlider } from './banner-slider';
import { HowItWorks } from './how-it-works';
import { CountUp } from './count-up';

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

const BANNER_SLIDES = [
  { src: banner1.src, alt: 'Recargas al instante — diamantes directo a tu cuenta' },
  { src: banner2.src, alt: 'Promociones nuevas todos los meses' },
  { src: banner3.src, alt: 'Desde 2024, la mejor página para tus diamantes' },
];

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

  const [hero, ...rest] = campaigns;
  const heroCombo = hero?.permanent ? hero.combos[0] : null;
  const heroFlyer = flyerUrl(hero?.flyerAssetUrl);
  const social = socialLinks();
  const hasSocial = social.facebook || social.instagram || social.tiktok;

  const top3 = top50.rows.slice(0, 3);
  const podiumOrder = top3.length === 3 ? [1, 0, 2] : top3.map((_, i) => i);
  const seasonDays = top50.season
    ? Math.max(0, Math.ceil((top50.season.endsAt.getTime() - Date.now()) / 86_400_000))
    : null;

  return (
    <main className="page">
      <div className="brand-bar">
        <div className="brand-bar-id">
          <img src={logo.src} width={40} height={40} alt="" decoding="async" />
          <span className="brand-bar-sep" aria-hidden="true">
            |
          </span>
          <span>LevelUp Store México</span>
        </div>
        {hasSocial && (
          <div className="social-links">
            {social.facebook && (
              <a href={social.facebook} target="_blank" rel="noreferrer" aria-label="Facebook">
                <FacebookIcon className="icon" />
              </a>
            )}
            {social.instagram && (
              <a href={social.instagram} target="_blank" rel="noreferrer" aria-label="Instagram">
                <InstagramIcon className="icon" />
              </a>
            )}
            {social.tiktok && (
              <a href={social.tiktok} target="_blank" rel="noreferrer" aria-label="TikTok">
                <TikTokIcon className="icon" />
              </a>
            )}
          </div>
        )}
      </div>

      <section className="hx-hero">
        <div className="hx-hero-copy hx-rise">
          {top50.season && (
            <p className="hx-kicker">
              Temporada {top50.season.seasonNumber}
              {seasonDays !== null ? ` · ${seasonDays} días` : ''}
            </p>
          )}
          <h1>
            Recarga. <span className="grad">Sube.</span> Gana.
          </h1>
          <p className="hx-hero-lead">
            Pon tu ID, elige tu pack y los diamantes llegan solos. Con Mi cuenta, cada recarga —
            en cualquier ID — suma al Level Pass y La Bóveda.
          </p>
          <div className="hx-cta-row">
            <Link href="/promociones" className="btn primary">
              Recargar ahora
            </Link>
            <Link href={session ? '/cuenta' : '/cuenta'} className="btn ghost">
              {session ? 'Ver mi progreso' : 'Crear mi cuenta'}
            </Link>
          </div>
          {(today > 0 || avgRating || customers >= 10) && (
            <div className="hx-live">
              <span className="hx-live-dot" aria-hidden="true" />
              {today > 0 && (
                <span>
                  <strong>{today}</strong> recarga{today === 1 ? '' : 's'} hoy
                </span>
              )}
              {avgRating && <span>★ {avgRating.toFixed(1)}</span>}
              {customers >= 10 && <span>+{roundDownSignificant(customers).toLocaleString('es-MX')} clientes</span>}
            </div>
          )}
        </div>
        <div className="hx-mascot hx-rise-2" aria-hidden="true">
          <div className="hx-mascot-glow" />
          <span className="hx-orb a" />
          <span className="hx-orb b" />
          <span className="hx-orb c" />
          <img src={mascot.src} alt="" decoding="async" />
        </div>
      </section>

      {top3.length > 0 && (
        <Link href="/ranking" className="hx-rise-3" style={{ display: 'block', marginBottom: 8 }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="hx-kicker" style={{ margin: 0 }}>
              Top de temporada{top50.season ? ` ${top50.season.seasonNumber}` : ''}
            </span>
            <div className="spacer" />
            <span className="hint">Ver ranking →</span>
          </div>
          <div className="hx-podium">
            {podiumOrder.map((i) => {
              const player = top3[i]!;
              const name = player.displayName ?? 'Jugador';
              const url = avatarUrl(player.avatarAssetUrl);
              return (
                <div key={player.playerProfileId} className={`hx-podium-slot rank-${player.rank}`}>
                  {url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={url} alt="" width={48} height={48} style={{ borderRadius: '50%', objectFit: 'cover', margin: '0 auto' }} />
                  ) : (
                    <div className="avatar" aria-hidden="true" style={{ width: 48, height: 48, fontSize: 16, margin: '0 auto' }}>
                      {initials(name)}
                    </div>
                  )}
                  <span className="hx-podium-name">{name}</span>
                  <span className="hx-podium-diamonds">{diamonds(player.seasonalDiamonds)} 💎</span>
                </div>
              );
            })}
          </div>
        </Link>
      )}

      {heroCombo &&
        (heroFlyer ? (
          <Link href={`/comprar/${heroCombo.key}`} className="mega-flyer-link">
            <img className="mega-flyer" src={heroFlyer} alt={hero!.name} decoding="async" />
          </Link>
        ) : (
          <Link href={`/comprar/${heroCombo.key}`} className="card mega">
            <div className="mega-tag">{hero!.badge ?? 'Solo clientes nuevos'}</div>
            <div className="mega-name">{hero!.name}</div>
            <div className="mega-diamonds">{diamonds(heroCombo.advertisedDiamonds)} 💎</div>
            <div className="mega-price">{mxn(heroCombo.priceMxnCents)}</div>
            <div className="mega-cta">Probar ahora →</div>
          </Link>
        ))}

      <BannerSlider slides={BANNER_SLIDES} />

      {(hero?.permanent ? rest : campaigns).length > 0 && (
        <>
          <div className="row section-head-row">
            <h2 className="section-title-lg">Ofertas disponibles</h2>
            <div className="spacer" />
            <Link href="/promociones" className="btn sm ghost-neon">
              Ver más →
            </Link>
          </div>
          <div className="promo-rail">
            {(hero?.permanent ? rest : campaigns).map((campaign) => {
              const flyer = flyerUrl(campaign.flyerAssetUrl);
              return (
                <Link key={campaign.key} href={`/promocion/${campaign.key}`} className="promo-card">
                  {flyer ? (
                    <img className="promo-flyer" src={flyer} alt={campaign.name} loading="lazy" decoding="async" />
                  ) : (
                    <div className="promo-flyer promo-flyer-empty">{campaign.name}</div>
                  )}
                  <div className="promo-name">{campaign.name}</div>
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

      {(delivered > 0 || customers > 0 || avgRating) && (
        <section className="card community">
          <h2 className="section-title-lg center">
            Comunidad <span className="grad">en tiempo real</span>
          </h2>
          <p className="page-sub center" style={{ marginBottom: 18 }}>
            Miles de jugadores ya confían en nosotros
          </p>
          <div className="stats-row">
            {customers > 0 && (
              <div className="counter">
                <div className="counter-value">
                  <CountUp value={customers} />
                </div>
                <div className="counter-label">clientes satisfechos</div>
              </div>
            )}
            {delivered > 0 && (
              <div className="counter">
                <div className="counter-value">
                  <CountUp value={delivered} />
                </div>
                <div className="counter-label">recargas realizadas</div>
              </div>
            )}
            {avgRating && (
              <div className="counter">
                <div className="counter-value">
                  <CountUp value={avgRating} decimals={1} suffix="/5" />
                </div>
                <div className="counter-label">valoración promedio</div>
              </div>
            )}
          </div>
        </section>
      )}

      <HowItWorks />
    </main>
  );
}
