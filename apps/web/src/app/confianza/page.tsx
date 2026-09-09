import type { Metadata } from 'next';
import Link from 'next/link';
import { countCompletedOrders, listTestimonials } from '@levelup/db';
import { db } from '../../lib/server';

// The brand is appended by the root layout's title template, so it is not
// repeated here.
export const metadata: Metadata = {
  title: 'Confianza',
  description: 'Por qué puedes recargar con nosotros con seguridad.',
  alternates: { canonical: '/confianza' },
};

export const dynamic = 'force-dynamic';

export default async function TrustPage() {
  const [delivered, testimonials] = await Promise.all([
    countCompletedOrders(db),
    listTestimonials(db),
  ]);

  return (
    <main className="page narrow">
      <h1 className="page-title">
        Tu confianza es <span className="grad">nuestro nivel</span>
      </h1>
      <p className="page-sub">
        Sabemos que comprar diamantes en internet da desconfianza. Así trabajamos.
      </p>

      {/* Only shown once it is a real number — a counter at zero says the
          opposite of what this page is for. */}
      {delivered > 0 && (
        <div className="card counter">
          <div className="counter-value">{delivered.toLocaleString('es-MX')}</div>
          <div className="counter-label">recargas entregadas</div>
        </div>
      )}

      <section className="trust-grid">
        <div className="card trust-item">
          <div className="trust-icon">🔒</div>
          <h2>Nunca pedimos tu contraseña</h2>
          <p>
            La recarga entra directo a tu cuenta con tu ID de jugador. No necesitamos —
            ni queremos — tus datos de acceso a Free Fire.
          </p>
        </div>

        <div className="card trust-item">
          <div className="trust-icon">✅</div>
          <h2>Verificamos tu cuenta antes de cobrar</h2>
          <p>
            Escribes tu ID y te mostramos el nombre de tu personaje. Si no eres tú, no
            pagas. Así nadie recarga a la cuenta equivocada.
          </p>
        </div>

        <div className="card trust-item">
          <div className="trust-icon">⚡</div>
          <h2>Entrega automática</h2>
          <p>
            En cuanto validamos tu pago, el sistema hace la recarga solo. No dependes de
            que alguien esté despierto para atenderte.
          </p>
        </div>

        <div className="card trust-item">
          <div className="trust-icon">📋</div>
          <h2>Puedes seguir tu pedido</h2>
          <p>
            Cada compra tiene su número. Consulta en{' '}
            <Link href="/pedidos" className="link">
              Tus pedidos
            </Link>{' '}
            en qué va la tuya, cuando quieras.
          </p>
        </div>
      </section>

      {testimonials.length > 0 && (
        <section>
          <h2 className="section-title">Lo que dicen nuestros clientes</h2>
          {testimonials.map((t, i) => (
            <blockquote className="card quote" key={i}>
              <p>“{t.quote}”</p>
              <footer>
                — {t.author}
                {t.combo && <span className="hint"> · {t.combo}</span>}
              </footer>
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
