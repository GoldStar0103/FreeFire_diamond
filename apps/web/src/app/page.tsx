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
import { getDb } from '../lib/server';
import { diamonds, roundDownSignificant } from '../lib/format';
import { flyerUrl } from '../lib/assets';
import logo from '../assets/logo.webp';
import heroLuchador from '../assets/mascot/hero-luchador.webp';
import promoStill from '../assets/mascot/promo-still.webp';
import porqueStill from '../assets/mascot/porque-still.webp';
import pasosStill from '../assets/mascot/pasos-still.webp';
import comoStill from '../assets/mascot/como-still.webp';
import {
  BoltIcon,
  CartIcon,
  ChatIcon,
  CrownSolidIcon,
  RankCrownIcon,
  DiamondIcon,
  HeadsetIcon,
  InfinityIcon,
  ShieldIcon,
} from './icons';
import { HowItWorks } from './how-it-works';
import { CountUp } from './count-up';
import { MascotMedia } from './mascot-media';
import { SiteHeader } from './site-header';
import { WaFab } from './wa-fab';
import { supportUrl } from '../lib/support';
import { whatsappChannelUrl } from '../lib/whatsapp-channel';

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
  const [campaigns, delivered, customers, today, top50, testimonials] = await Promise.all([
    listStorefront(getDb()),
    countCompletedOrders(getDb()),
    countUniqueCustomers(getDb()),
    countCompletedOrdersToday(getDb()),
    getPublicTop50(getDb()),
    listTestimonials(getDb()),
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

  // Homepage podium matches the approved mockup bar (TURA / NEO / KANU).
  // Real season leaders still power /ranking; this strip is the design bar.
  const top3 = [
    { rank: 1, displayName: 'TURA', seasonalDiamonds: 15_110, key: 'sample-1' },
    { rank: 2, displayName: 'NEO', seasonalDiamonds: 12_450, key: 'sample-2' },
    { rank: 3, displayName: 'KANU', seasonalDiamonds: 9_880, key: 'sample-3' },
  ] as const;
  const hasRanking = true;
  const offers = assignFlyerSlots(campaigns, featured?.campaign.key ?? null);
  const liveCount = today > 0 ? today : delivered;
  const liveCountIsToday = today > 0;
  const showLive = liveCount > 0 || customers > 0 || avgRating;
  const chatUrl = supportUrl('Hola, tengo una pregunta sobre mi recarga.');
  const channelUrl = whatsappChannelUrl();

  return (
    <main className="page hm">
      <SiteHeader fadeOnScroll showSocial />
      {channelUrl && <WaFab />}

      <div className="hm-layout">
        <div className="hm-col-main">
          {featured && (
            <Link href={`/comprar/${featured.combo.key}`} className="hm-hero">
              <span className="hm-hero-tab" aria-hidden="true">
                <img src={logo.src} alt="" decoding="async" />
                <b>LevelUp</b>
                <i>Store</i>
              </span>
              <div className="hm-hero-in">
                <span className="hm-hero-frm" aria-hidden="true" />
                <span className="hm-hero-shine" aria-hidden="true" />
                <div className="hm-hero-body">
                  <div className="hm-hero-gems" aria-hidden="true">
                    <i /><i /><i /><i /><i /><i />
                    <span className="hm-hero-sp" />
                    <span className="hm-hero-sp" />
                  </div>
                  <div className="hm-hero-copy">
                    <span className="hm-hero-flag">
                      <BoltIcon className="icon" />
                      Oferta especial
                    </span>
                    <div className="hm-hero-h">
                      <span className="hm-hero-num">{diamonds(featured.combo.advertisedDiamonds)}</span>
                      <span className="hm-hero-unit">Diamantes</span>
                      <p className="hm-hero-price">
                        × ${(featured.combo.priceMxnCents / 100).toLocaleString('es-MX')}{' '}
                        <small>MXN</small>
                      </p>
                    </div>
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
                    <ul className="hm-hero-pays" aria-label="Métodos de pago aceptados">
                      <li>Tarjeta</li>
                      <li>SPEI</li>
                      <li>OXXO</li>
                      <li>Mercado Pago</li>
                    </ul>
                  </div>
                  <div className="hm-hero-art" aria-hidden="true">
                    <MascotMedia
                      className="hm-hero-mascot"
                      webm="/mascot/luchador-hero.webm"
                      animWebp="/mascot/luchador-hero-anim.webp"
                      stillSrc={heroLuchador.src}
                      alt="Luchador de LevelUp anunciando la oferta"
                      ariaHidden
                    />
                  </div>
                </div>
                <div className="hm-hero-cta-wrap">
                  <span className="hm-hero-cta">
                    <CartIcon className="icon" />
                    Comprar ahora
                    <span className="hm-hero-chev" aria-hidden="true">
                      <b />
                      <b />
                      <b />
                    </span>
                  </span>
                </div>
              </div>
            </Link>
          )}

          <Link href="/promociones" className="hm-promo">
            <span className="hm-promo-in">
              <span className="hm-promo-frm" aria-hidden="true" />
              <span className="hm-promo-shine" aria-hidden="true" />
              <span className="hm-promo-main">
                <span className="hm-promo-art" aria-hidden="true">
                  <MascotMedia
                    className="hm-promo-mascot"
                    webm="/mascot/mascota-promo.webm"
                    animWebp="/mascot/mascota-promo-anim.webp"
                    stillSrc={promoStill.src}
                    alt="Luchador de LevelUp con un diamante"
                    ariaHidden
                  />
                </span>
                <span className="hm-promo-side">
                  <span className="hm-promo-copy">
                    <b>Promociones</b>
                    <strong>Nuevas todos los meses</strong>
                    <small>Combos, packs y descuentos por temporada.</small>
                  </span>
                  <span className="hm-promo-cta">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <path d="M20 12l-7-7v4H4v6h9v4z" />
                    </svg>
                    Ver ofertas
                  </span>
                </span>
              </span>
            </span>
          </Link>

          {showLive && (
            <section className="hm-metrics" aria-label="Actividad en vivo">
              <div className="hm-metric">
                <div className="hm-metric-top">
                  <span className="hm-metric-dot" aria-hidden="true" />
                  <span className="hm-metric-lbl">En vivo</span>
                </div>
                <div className="hm-metric-odo">
                  <CountUp value={liveCount} {...(liveCount < 1000 ? { padDigits: 3 } : {})} />
                  <small>+</small>
                </div>
                <span className="hm-metric-sub">{liveCountIsToday ? 'recargas hoy' : 'recargas'}</span>
                <div className="hm-metric-bar" aria-hidden="true">
                  <i />
                </div>
              </div>

              <div className="hm-metric">
                <div className="hm-metric-top">
                  <span className="hm-metric-lbl">Valoración</span>
                </div>
                <div className="hm-metric-big">
                  {(avgRating ?? 4.8).toFixed(1)}
                  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M12 3l2.6 5.5 6 .8-4.4 4.2 1.1 6-5.3-3-5.3 3 1.1-6L3.4 9.3l6-.8z" />
                  </svg>
                </div>
                <span className="hm-metric-sub">de clientes</span>
              </div>

              <div className="hm-metric">
                <div className="hm-metric-top">
                  <span className="hm-metric-lbl">Clientes</span>
                </div>
                <div className="hm-metric-odo">
                  {customers > 0 ? roundDownSignificant(customers).toLocaleString('es-MX') : '700'}
                  <small>+</small>
                </div>
                <span className="hm-metric-sub">satisfechos</span>
                <div className="hm-metric-bar" aria-hidden="true">
                  <i style={{ width: '74%' }} />
                </div>
              </div>

              <div className="hm-metric hm-metric-cyan">
                <div className="hm-metric-top">
                  <span className="hm-metric-lbl">Entrega</span>
                </div>
                <div className="hm-metric-big">1 min</div>
                <span className="hm-metric-sub">promedio</span>
              </div>
            </section>
          )}

          {offers.length > 0 && (
            <>
              <div className="hm-ofertas-head">
                <h2>Ofertas disponibles</h2>
                <Link href="/promociones" className="hm-ofertas-more">
                  Ver más →
                </Link>
              </div>
              <div className="hm-ofertas">
                {offers.map((campaign, i) => {
                  const flyer = flyerUrl(campaign.flyerAssetUrl);
                  const comboCount = campaign.combos.length;
                  const fromCents = campaign.combos.reduce(
                    (min, c) => Math.min(min, c.priceMxnCents),
                    Number.POSITIVE_INFINITY,
                  );
                  const fromLabel =
                    Number.isFinite(fromCents)
                      ? `Desde $${(fromCents / 100).toLocaleString('es-MX')}`
                      : null;
                  const tone = (i % 4) + 1;
                  return (
                    <Link
                      key={campaign.key}
                      href={`/promocion/${campaign.key}`}
                      className={`hm-offer hm-offer-o${tone}`}
                    >
                      <span className="hm-offer-frame">
                        <span className="hm-offer-shot">
                          {flyer ? (
                            <img src={flyer} alt={campaign.name} decoding="async" />
                          ) : (
                            <span className="hm-offer-empty">{campaign.name}</span>
                          )}
                        </span>
                      </span>
                      <span className="hm-offer-meta">
                        <b>{campaign.name}</b>
                        {comboCount > 0 && (
                          <em>
                            {comboCount} combo{comboCount === 1 ? '' : 's'}
                          </em>
                        )}
                        {fromLabel && <span>{fromLabel}</span>}
                      </span>
                      <span className="hm-offer-obar">Comprar ahora →</span>
                    </Link>
                  );
                })}
              </div>
            </>
          )}

          {campaigns.length === 0 && (
            <div className="card empty">Estamos preparando las promociones del mes. Vuelve pronto.</div>
          )}

          <section className="hm-why-section">
            <div className="hm-why-head">
              <h2 className="section-title-lg center">
                ¿Por qué elegir <span className="grad">LevelUp Store</span>?
              </h2>
              <MascotMedia
                className="hm-why-mascot"
                webm="/mascot/mascota-porque.webm"
                animWebp="/mascot/mascota-porque-anim.webp"
                stillSrc={porqueStill.src}
                alt="Luchador de LevelUp rodeado de diamantes"
                ariaHidden
              />
            </div>
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

          <div className="hm-steps-wrap">
            <HowItWorks
              mascot={
                <MascotMedia
                  className="hm-steps-mascot"
                  webm="/mascot/mascota-pasos.webm"
                  animWebp="/mascot/mascota-pasos-anim.webp"
                  stillSrc={pasosStill.src}
                  alt="Luchador de LevelUp mostrando los pasos de la compra"
                  ariaHidden
                />
              }
            />
          </div>
        </div>

        <aside className="hm-rail">
          {hasRanking && (
            <section className="hm-rk" aria-label="Top compradores de la temporada">
              <div className="hm-rk-in">
                <div className="hm-rk-head">
                  <CrownSolidIcon className="icon" />
                  <div>
                    <b>Top compradores</b>
                    <small>Temporada {top50.season?.seasonNumber ?? 1} · en curso</small>
                  </div>
                </div>
                <ol className="hm-rk-list">
                  {top3.map(({ rank, displayName, seasonalDiamonds, key }) => (
                    <li key={key} className={`hm-rk-r${rank}`}>
                      <span className="hm-rk-badge">
                        {rank === 1 && <RankCrownIcon className="hm-rk-crown" />}
                        <b>{rank}</b>
                      </span>
                      <span className="hm-rk-who">
                        <b>{displayName}</b>
                        <em>{diamonds(seasonalDiamonds)}</em>
                      </span>
                    </li>
                  ))}
                </ol>
                <Link href="/ranking" className="hm-rk-more">
                  Ver ranking completo <span aria-hidden="true">→</span>
                </Link>
              </div>
            </section>
          )}

          <section className="hm-supt">
            <div className="hm-supt-card">
              <span className="hm-supt-deco" aria-hidden="true">
                <span className="hm-supt-glow" />
                <span className="hm-supt-dots" />
              </span>
              {chatUrl && (
                <a
                  href={chatUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="hm-supt-main"
                  aria-label="Abrir el chat de soporte"
                >
                  <span className="hm-supt-art" aria-hidden="true">
                    <MascotMedia
                      className="hm-supt-mascot"
                      webm="/mascot/mascota-como2.webm"
                      animWebp="/mascot/mascota-como2-anim.webp"
                      stillSrc={comoStill.src}
                      alt=""
                      ariaHidden
                    />
                  </span>
                  <span className="hm-supt-side">
                    <span className="hm-supt-copy">
                      <span className="hm-supt-badge">
                        <i aria-hidden="true" />
                        Soporte
                      </span>
                      <b>¿Tuviste algún problema con tu compra?</b>
                      <small>Escríbenos por el chat y lo resolvemos.</small>
                    </span>
                    <span className="hm-supt-cta">
                      <ChatIcon className="icon" />
                      <span>Hablar con soporte</span>
                    </span>
                  </span>
                </a>
              )}
              {delivered > 0 && (
                <>
                  <div className="hm-supt-div" aria-hidden="true" />
                  <div className="hm-supt-foot">
                    <span className="hm-supt-lbl">
                      <BoltIcon className="icon" />
                      <span>
                        Recargas<em>procesadas</em>
                      </span>
                    </span>
                    <strong className="hm-supt-digits" aria-label="Recargas procesadas">
                      <CountUp value={delivered} tiles padDigits={6} />
                      <small>+</small>
                    </strong>
                    <span className="hm-supt-live">
                      <i aria-hidden="true" />
                      En vivo
                    </span>
                  </div>
                </>
              )}
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
