import type { Metadata } from 'next';
import Link from 'next/link';
import { getPublicTop50, listStorefront } from '@levelup/db';
import { getCustomerSession } from '../lib/customer-session';
import { getDb } from '../lib/server';
import { loadAccountNotices } from '../lib/account-notices';
import { socialLinks } from '../lib/social';
import heroArt from '../assets/make/home-hero.jpg';
import lowerArt from '../assets/make/home-lower-approved.jpg';
import offer1 from '../assets/make/offer-1.jpg';
import offer2 from '../assets/make/offer-2.jpg';
import offer3 from '../assets/make/offer-3.jpg';
import offer4 from '../assets/make/offer-4.jpg';
import { NotificationBell } from './notifications';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { alternates: { canonical: '/' } };

const OFFERS = [
  { src: offer1, title: 'Energía Insana', glow: 'mk-glow-1' },
  { src: offer2, title: 'Recargas Locochonas', glow: 'mk-glow-2' },
  { src: offer3, title: 'Super Packs', glow: 'mk-glow-3' },
  { src: offer4, title: 'Descuentos Chidos', glow: 'mk-glow-4' },
] as const;

function plain(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** The flyer opens its live campaign when one is on sale. Otherwise it stays a sample. */
function offerHref(campaigns: { key: string; name: string }[], title: string): string | null {
  const needle = plain(title);
  const match = campaigns.find((campaign) => {
    const name = plain(campaign.name);
    return name.includes(needle) || needle.includes(name);
  });
  return match ? `/promocion/${match.key}` : null;
}

type Ranked = Awaited<ReturnType<typeof getPublicTop50>>['rows'][number];

/** Second, first, third — the order painted on the approved ribbon. */
function podiumOrder(rows: Ranked[]): Ranked[] {
  const top = [...rows].sort((a, b) => a.rank - b.rank).slice(0, 3);
  if (top.length < 2) return top;
  if (top.length === 2) return [top[1]!, top[0]!];
  return [top[1]!, top[0]!, top[2]!];
}

export default async function HomePage() {
  const db = getDb();
  const [campaigns, top50, session] = await Promise.all([
    listStorefront(db),
    getPublicTop50(db),
    getCustomerSession(),
  ]);
  const notices = session ? await loadAccountNotices(session.playerProfileId, session.playerId) : [];
  const packs = campaigns.flatMap((campaign) => campaign.combos.map((combo) => ({ campaign, combo })));
  const featured =
    packs.find((p) => p.combo.advertisedDiamonds === 110) ??
    packs.find((p) => p.campaign.permanent) ??
    packs[0] ??
    null;
  const social = socialLinks();
  const podium = podiumOrder(top50.rows);
  const buyHref = featured ? `/comprar/${featured.combo.key}` : '/promociones';

  return (
    <main className="make-home">
      <h1 className="sr-only">LevelUp Store México</h1>
      <section className="mk-hero" aria-label="LevelUp Store promociones principales">
        <img className="mk-hero-art" src={heroArt.src} alt="" />
        {social.tiktok && (
          <a className="mk-hit mk-tiktok" href={social.tiktok} target="_blank" rel="noreferrer">
            <span className="sr-only">TikTok</span>
          </a>
        )}
        {social.instagram && (
          <a className="mk-hit mk-instagram" href={social.instagram} target="_blank" rel="noreferrer">
            <span className="sr-only">Instagram</span>
          </a>
        )}
        {social.facebook && (
          <a className="mk-hit mk-facebook" href={social.facebook} target="_blank" rel="noreferrer">
            <span className="sr-only">Facebook</span>
          </a>
        )}
        <div className="mk-hit mk-bell">
          <NotificationBell signedIn={Boolean(session)} notices={notices} />
        </div>
        <Link className="mk-hit mk-profile" href="/cuenta">
          <span className="sr-only">{session ? 'Mi cuenta' : 'Crear mi cuenta'}</span>
        </Link>
        {[2, 1, 3].map((rank) => {
          const player = podium.find((row) => row.rank === rank);
          const slot = rank === 1 ? 2 : rank === 2 ? 1 : 3;
          return (
            <Link
              key={rank}
              className={`mk-hit mk-player mk-player-${slot}`}
              href={player ? `/jugador/${player.playerProfileId}` : '/ranking'}
            >
              <span className="sr-only">
                {player
                  ? `Puesto ${player.rank}, ${player.displayName ?? 'Jugador'}`
                  : `Puesto ${rank}`}
              </span>
            </Link>
          );
        })}
        <Link className="mk-hit mk-ranking" href="/ranking">
          <span className="sr-only">Ver tabla completa</span>
        </Link>
        <Link className="mk-hit mk-buy" href={buyHref}>
          <span className="sr-only">Comprar ahora</span>
        </Link>
        <Link className="mk-hit mk-promo" href="/promociones">
          <span className="sr-only">Ver ofertas</span>
        </Link>
      </section>

      <section className="mk-offers" id="ofertas" aria-labelledby="offers-title">
        <header className="mk-offers-head">
          <h2 id="offers-title">
            <span aria-hidden="true">◇</span> OFERTAS <strong>DISPONIBLES</strong>
          </h2>
          <Link href="/promociones">Ver más →</Link>
        </header>
        {OFFERS.every((offer) => !offerHref(campaigns, offer.title)) && (
          <p className="mk-reference-note">Vista visual de referencia · campañas no activas</p>
        )}
        <div className="mk-offers-grid">
          {OFFERS.map((offer) => {
            const href = offerHref(campaigns, offer.title);
            return (
              <Link key={offer.title} className={`mk-offer ${offer.glow}`} href={href ?? '/promociones'}>
                <img src={offer.src.src} alt="" />
                <span className="sr-only">{href ? offer.title : `Creativo de muestra: ${offer.title}`}</span>
                {!href && <span>MUESTRA VISUAL</span>}
              </Link>
            );
          })}
        </div>
      </section>

      <section className="mk-lower" id="como-funciona" aria-label="Beneficios y proceso de compra">
        <img src={lowerArt.src} alt="Por qué elegir LevelUp Store y cómo funciona una recarga en cuatro pasos" />
        <Link className="mk-art mk-art-inicio" href="/">
          <span className="sr-only">Inicio</span>
        </Link>
        <Link className="mk-art mk-art-ofertas" href="/promociones">
          <span className="sr-only">Ofertas</span>
        </Link>
        <a className="mk-art mk-art-como" href="#como-funciona">
          <span className="sr-only">Cómo funciona</span>
        </a>
        <Link className="mk-art mk-art-soporte" href="/soporte">
          <span className="sr-only">Soporte</span>
        </Link>
        <Link className="mk-art mk-art-terminos" href="/legal/terminos">
          <span className="sr-only">Términos y condiciones</span>
        </Link>
        <Link className="mk-art mk-art-privacidad" href="/legal/privacidad">
          <span className="sr-only">Política de privacidad</span>
        </Link>
        <Link className="mk-art mk-art-pagos" href="/confianza">
          <span className="sr-only">Métodos de pago</span>
        </Link>
        {social.facebook && (
          <a className="mk-art mk-art-fb" href={social.facebook} target="_blank" rel="noreferrer">
            <span className="sr-only">Facebook</span>
          </a>
        )}
        {social.instagram && (
          <a className="mk-art mk-art-ig" href={social.instagram} target="_blank" rel="noreferrer">
            <span className="sr-only">Instagram</span>
          </a>
        )}
        {social.tiktok && (
          <a className="mk-art mk-art-tt" href={social.tiktok} target="_blank" rel="noreferrer">
            <span className="sr-only">TikTok</span>
          </a>
        )}
      </section>
    </main>
  );
}
