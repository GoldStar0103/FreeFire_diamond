import type { Metadata } from 'next';
import Link from 'next/link';
import { countCompletedOrders, countUniqueCustomers, listTestimonials } from '@levelup/db';
import { getDb } from '../../lib/server';
import { initials } from '../../lib/format';

// The brand is appended by the root layout's title template, so it is not
// repeated here.
export const metadata: Metadata = {
  title: 'Confianza',
  description: 'Por qué puedes recargar con nosotros con seguridad.',
  alternates: { canonical: '/confianza' },
};

export const dynamic = 'force-dynamic';

/** A star row for a testimonial that actually has a rating on file. */
function Stars({ rating }: { rating: number }) {
  return (
    <div className="stars" aria-label={`${rating} de 5 estrellas`}>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} aria-hidden="true">
          {i < rating ? '★' : '☆'}
        </span>
      ))}
    </div>
  );
}

export default async function TrustPage() {
  const [delivered, customers, testimonials] = await Promise.all([
    countCompletedOrders(getDb()),
    countUniqueCustomers(getDb()),
    listTestimonials(getDb()),
  ]);

  // Real, not a marketing round figure — same principle as the testimonials
  // only ever showing quotes that actually came from a customer. Needs a
  // handful of ratings before it means anything; one 5-star review is not
  // "our average rating".
  const rated = testimonials.filter((t) => t.rating);
  const avgRating =
    rated.length >= 3
      ? (rated.reduce((sum, t) => sum + (t.rating ?? 0), 0) / rated.length).toFixed(1)
      : null;

  return (
    <main className="page narrow">
      <h1 className="page-title">
        Tu confianza es <span className="grad">nuestro nivel</span>
      </h1>
      <p className="page-sub">
        Sabemos que comprar diamantes en internet da desconfianza. Así trabajamos.
      </p>

      {(delivered > 0 || customers > 0 || avgRating) && (
        <div className="stats-row">
          {delivered > 0 && (
            <div className="card counter">
              <div className="counter-value">{delivered.toLocaleString('es-MX')}</div>
              <div className="counter-label">recargas entregadas</div>
            </div>
          )}
          {customers > 0 && (
            <div className="card counter">
              <div className="counter-value">{customers.toLocaleString('es-MX')}</div>
              <div className="counter-label">jugadores confían</div>
            </div>
          )}
          {avgRating && (
            <div className="card counter">
              <div className="counter-value">{avgRating}/5</div>
              <div className="counter-label">{rated.length} reseñas</div>
            </div>
          )}
        </div>
      )}

      <section className="trust-grid">
        <div className="card trust-item">
          <div className="trust-icon">⚡</div>
          <h2>Entrega al instante</h2>
          <p>
            En cuanto validamos tu pago, el sistema hace la recarga solo — no dependes de que
            alguien esté despierto para atenderte.
          </p>
        </div>

        <div className="card trust-item">
          <div className="trust-icon">🛡️</div>
          <h2>Pagos seguros</h2>
          <p>
            Escribes tu ID y te mostramos el nombre de tu personaje antes de cobrarte. Si no eres
            tú, no pagas — así nadie recarga a la cuenta equivocada.
          </p>
        </div>

        <div className="card trust-item">
          <div className="trust-icon">🔒</div>
          <h2>Sin contraseñas</h2>
          <p>
            La recarga entra directo a tu cuenta con tu ID de jugador. No necesitamos — ni
            queremos — tus datos de acceso a Free Fire.
          </p>
        </div>

        <div className="card trust-item">
          <div className="trust-icon">🎧</div>
          <h2>Soporte real 24/7</h2>
          <p>
            Cada compra tiene su número de seguimiento y un{' '}
            <Link href="/soporte" className="link">
              equipo de soporte
            </Link>{' '}
            listo para ayudarte si algo no sale como esperabas.
          </p>
        </div>
      </section>

      {testimonials.length > 0 && (
        <section>
          <h2 className="section-title">Lo que dicen nuestros clientes</h2>
          {testimonials.map((t, i) => (
            <blockquote className="card quote" key={i}>
              <div className="quote-head">
                <div className="avatar" aria-hidden="true">
                  {initials(t.author)}
                </div>
                <div>
                  <div className="quote-author">{t.author}</div>
                  {t.rating && <Stars rating={t.rating} />}
                </div>
              </div>
              <p>“{t.quote}”</p>
              {t.combo && <footer className="hint">{t.combo}</footer>}
            </blockquote>
          ))}
        </section>
      )}

      <section className="card">
        <h2 className="mini-title">¿Primera vez?</h2>
        <p className="hint">
          Prueba con la oferta de $10. Es la forma más barata de comprobar que somos
          reales, y por eso la tenemos.
        </p>
        <Link href="/" className="btn primary wide" style={{ marginTop: 12 }}>
          Ver la oferta
        </Link>
      </section>
    </main>
  );
}
