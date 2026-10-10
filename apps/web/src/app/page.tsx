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
// Imported through the bundler rather than served from `public/`: the build
// emits it under /_next/static with a content hash, which the Docker image
// copies and browsers may cache forever. `public/` is not copied into the
// standalone image, so a logo there would boot fine locally and 404 in
// production.
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

  // Same "needs at least a few ratings to mean anything" rule as /confianza —
  // one 5-star review is not an average.
  const rated = testimonials.filter((t) => t.rating);
  const avgRating =
    rated.length >= 3 ? rated.reduce((sum, t) => sum + (t.rating ?? 0), 0) / rated.length : null;

  // Permanent campaigns sort first, so the $10 entry offer leads. It is the
  // trust-breaker for first-time buyers, not just another promo.
  const [hero, ...rest] = campaigns;
  const heroCombo = hero?.permanent ? hero.combos[0] : null;
  const heroFlyer = flyerUrl(hero?.flyerAssetUrl);
  const social = socialLinks();
  const hasSocial = social.facebook || social.instagram || social.tiktok;

  // Podium order for a 3-wide strip: 2nd, 1st, 3rd, same visual convention as
  // /ranking's own podium — 1st reads as the tallest/center card.
  const top3 = top50.rows.slice(0, 3);
  const podiumOrder = top3.length === 3 ? [1, 0, 2] : top3.map((_, i) => i);

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

      {top3.length > 0 && (
        <Link href="/ranking" className="card hm-top3">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="hm-top3-label">
              🏆 Top de temporada{top50.season ? ` ${top50.season.seasonNumber}` : ''}
            </span>
            <span className="hint">Ver ranking →</span>
          </div>
          <div className="hm-top3-row">
            {podiumOrder.map((i) => {
              const player = top3[i]!;
              const name = player.displayName ?? 'Jugador';
              const url = avatarUrl(player.avatarAssetUrl);
              return (
                <div key={player.playerProfileId} className={`hm-top3-slot hm-top3-${player.rank}`}>
                  {url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={url} alt="" width={40} height={40} style={{ borderRadius: '50%', objectFit: 'cover' }} />
                  ) : (
                    <div className="avatar" aria-hidden="true" style={{ width: 40, height: 40, fontSize: 15 }}>
                      {initials(name)}
                    </div>
                  )}
                  <span className="hm-top3-name">{name}</span>
                  <span className="hm-top3-diamonds">{diamonds(player.seasonalDiamonds)} 💎</span>
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

      {(today > 0 || avgRating) && (
        <div className="row card hm-live">
          <span className="hm-live-dot" aria-hidden="true" />
          {today > 0 && (
            <span>
              <strong>{today}</strong> <span className="hint">recarga{today === 1 ? '' : 's'} hoy</span>
            </span>
          )}
          <div className="spacer" />
          {avgRating && (
            <span className="hm-live-rating">
              ⭐ {avgRating.toFixed(1)}
            </span>
          )}
          {customers >= 10 && (
            <span className="hint">+{roundDownSignificant(customers).toLocaleString('es-MX')} clientes</span>
          )}
          <img src={mascot.src} className="hm-live-mascot" alt="" aria-hidden="true" decoding="async" />
        </div>
      )}

      {/*
        The homepage used to embed every campaign's full flyer plus its whole
        combo grid inline — everything, all at once, before anyone had chosen
        what they were interested in. This is the flyer-first view instead:
        one tap on a campaign's own art is the only thing asked of a visitor
        here. The detail (every combo, every price) lives one tap away at
        /promocion/[key] — see that page for what used to be right here.
      */}
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
              // What the database holds is a storage key, not a URL. Rendering it
              // straight into `src` is what made every uploaded flyer a broken image.
              const flyer = flyerUrl(campaign.flyerAssetUrl);

              return (
                <Link key={campaign.key} href={`/promocion/${campaign.key}`} className="promo-card">
                  {flyer ? (
                    <img
                      className="promo-flyer"
                      src={flyer}
                      alt={campaign.name}
                      loading="lazy"
                      decoding="async"
                    />
                  ) : (
                    // A campaign the owner has not uploaded art for yet still has
                    // to be reachable — a silent gap in the rail reads as broken,
                    // not as "coming soon".
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

      <div className="card" style={{ marginTop: 16 }}>
        <h2 className="mini-title">Mi LevelUp</h2>
        <p className="hint">
          Un ID para el ranking (se cambia una vez por temporada). Cualquier recarga con tu
          cuenta — aunque sea otro ID — suma al Level Pass y La Bóveda.
        </p>
        <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
          <Link href="/cuenta" className="btn primary">
            {session ? 'Ver mi progreso' : 'Crear mi cuenta'}
          </Link>
          <Link href="/ranking" className="btn ghost">
            Ver ranking
          </Link>
        </div>
      </div>
    </main>
  );
}
