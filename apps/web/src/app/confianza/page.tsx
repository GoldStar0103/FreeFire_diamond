import type { Metadata } from 'next';
import Link from 'next/link';
import {
  countCompletedOrders,
  countUniqueCustomers,
  listStorefront,
  listTestimonials,
} from '@levelup/db';
import { getDb } from '../../lib/server';
import { initials } from '../../lib/format';
import { BoltIcon, HeadsetIcon, KeyIcon, ShieldIcon } from '../icons';
import { MascotMedia } from '../mascot-media';
import { SiteHeader } from '../site-header';
import { ReviewsCarousel } from './reviews-carousel';
import confianzaStill from '../../assets/mascot/confianza-still.webp';

export const metadata: Metadata = {
  title: 'Confianza',
  description: 'Cómo trabaja LevelUp Store: entrega al instante, pagos seguros y lo que dicen sus clientes.',
  alternates: { canonical: '/confianza' },
};

export const dynamic = 'force-dynamic';

function Stars({ rating }: { rating: number }) {
  return (
    <div className="cf-stars" aria-label={`${rating} de 5 estrellas`}>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className={i < rating ? '' : 'off'} aria-hidden="true">
          ★
        </span>
      ))}
    </div>
  );
}

export default async function TrustPage() {
  const db = getDb();
  const [campaigns, delivered, customers, testimonials] = await Promise.all([
    listStorefront(db),
    countCompletedOrders(db),
    countUniqueCustomers(db),
    listTestimonials(db),
  ]);

  const rated = testimonials.filter((t) => t.rating);
  const avgRating =
    rated.length >= 3 ? rated.reduce((sum, t) => t.rating! + sum, 0) / rated.length : null;
  const reviewCount = testimonials.length;
  const ratingLabel = avgRating !== null ? `${avgRating.toFixed(1)}/5` : '—';

  const trustCombo =
    campaigns.flatMap((c) => c.combos).find((c) => c.advertisedDiamonds === 110) ?? null;
  const offerHref = trustCombo ? `/comprar/${trustCombo.key}` : '/promociones';
  const offerPrice = trustCombo
    ? `$${(trustCombo.priceMxnCents / 100).toLocaleString('es-MX')}`
    : '$15';

  return (
    <main className="page cf">
      <SiteHeader />

      <section className="cf-head" aria-labelledby="cf-titulo">
        <span className="cf-eyebrow">
          <i aria-hidden="true" />
          Confianza
        </span>
        <h1 id="cf-titulo">
          Tu confianza es <em>nuestro nivel</em>
        </h1>
        <p>Sabemos que comprar diamantes en internet da desconfianza. Así trabajamos.</p>
        <MascotMedia
          className="cf-head-mascot"
          webm="/mascot/confianza-luchador.webm"
          animWebp="/mascot/confianza-luchador-anim.webp"
          stillSrc={confianzaStill.src}
          alt="Luchador de LevelUp con audífonos, guiñando el ojo y con los pulgares arriba"
        />
      </section>

      <div className="cf-stats-row" role="list" aria-label="Números de la tienda">
        <div className="cf-counter" role="listitem">
          <span className="cf-counter-dot" aria-hidden="true" />
          <b>{delivered.toLocaleString('es-MX')}</b>
          <span>
            recargas
            <br />
            entregadas
          </span>
        </div>
        <div className="cf-counter" role="listitem">
          <b>{customers.toLocaleString('es-MX')}</b>
          <span>
            jugadores
            <br />
            confían
          </span>
        </div>
        <div className="cf-counter" role="listitem">
          <b>{ratingLabel}</b>
          <span>
            {reviewCount.toLocaleString('es-MX')}
            <br />
            reseñas
          </span>
        </div>
      </div>

      <div className="cf-trust-grid">
        <article className="cf-trust">
          <span className="cf-trust-ic" aria-hidden="true">
            <BoltIcon className="icon" />
          </span>
          <h3>Entrega al instante</h3>
          <p>
            En cuanto validamos tu pago, el sistema hace la recarga solo — no dependes de que
            alguien esté despierto para atenderte.
          </p>
        </article>
        <article className="cf-trust">
          <span className="cf-trust-ic" aria-hidden="true">
            <ShieldIcon className="icon" />
          </span>
          <h3>Pagos seguros</h3>
          <p>
            Escribes tu ID y te mostramos el nombre de tu personaje antes de cobrarte. Si no eres
            tú, no pagas — así nadie recarga a la cuenta equivocada.
          </p>
        </article>
        <article className="cf-trust">
          <span className="cf-trust-ic" aria-hidden="true">
            <KeyIcon className="icon" />
          </span>
          <h3>Sin contraseñas</h3>
          <p>
            La recarga entra directo a tu cuenta con tu ID de jugador. No necesitamos — ni
            queremos — tus datos de acceso a Free Fire.
          </p>
        </article>
        <article className="cf-trust">
          <span className="cf-trust-ic" aria-hidden="true">
            <HeadsetIcon className="icon" />
          </span>
          <h3>Soporte real 24/7</h3>
          <p>
            Cada compra tiene su número de seguimiento y un equipo de soporte listo para ayudarte
            si algo no sale como esperabas.
          </p>
        </article>
      </div>

      {reviewCount > 0 && (
        <>
          <div className="cf-titulo-bloque">
            <h2>Lo que dicen nuestros clientes</h2>
            <span className="cf-line" aria-hidden="true" />
            <span className="cf-count">{reviewCount.toLocaleString('es-MX')} reseñas</span>
          </div>
          <ReviewsCarousel count={reviewCount}>
            {testimonials.map((t) => (
              <article className="cf-rev" key={`${t.author}-${t.quote.slice(0, 24)}`}>
                <div className="cf-rev-top">
                  <span className="cf-rev-av" aria-hidden="true">
                    {initials(t.author)}
                  </span>
                  <div className="cf-rev-who">
                    <b>{t.author}</b>
                    {t.rating ? <Stars rating={t.rating} /> : null}
                  </div>
                </div>
                <blockquote>&ldquo;{t.quote}&rdquo;</blockquote>
                {t.combo ? <span className="cf-rev-tag">{t.combo}</span> : null}
              </article>
            ))}
          </ReviewsCarousel>
        </>
      )}

      <section className="cf-primera">
        <h2>¿Primera vez?</h2>
        <p>
          Prueba con la oferta de confianza: 110 diamantes x {offerPrice}. Es la forma más barata de
          comprobar que somos reales, y por eso la tenemos.
        </p>
        <Link href={offerHref} className="cf-primera-btn">
          Ver la oferta
          <span aria-hidden="true">→</span>
        </Link>
      </section>
    </main>
  );
}
