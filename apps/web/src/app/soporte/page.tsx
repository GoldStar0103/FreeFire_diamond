import type { Metadata } from 'next';
import { supportUrl } from '../../lib/support';
import { legalIdentity } from '../../lib/legal';
import { getStripe } from '../../lib/stripe';

export const metadata: Metadata = {
  title: 'Soporte',
  description: 'Horarios, preguntas frecuentes y cómo contactarnos.',
  alternates: { canonical: '/soporte' },
};

export const dynamic = 'force-dynamic';

/**
 * A real page instead of a bare WhatsApp redirect.
 *
 * The client's complaint was specific: support offered nothing but a link
 * that opened WhatsApp with no context — no hours, no idea what to expect,
 * nothing to check before writing in. This is that context. WhatsApp is
 * still the actual channel (see the primary card below) — this page exists
 * so someone lands somewhere informative first, footer or bottom nav, rather
 * than straight into a chat window.
 */
export default function SupportPage() {
  const chatUrl = supportUrl('Hola, tengo una pregunta sobre mi recarga.');
  const problemUrl = supportUrl('Hola, tengo un problema con mi recarga.');
  const { contactEmail } = legalIdentity();
  const cardEnabled = getStripe() !== null;

  return (
    <main className="page narrow">
      <h1 className="page-title">
        <span aria-hidden="true">🎧</span> Soporte
      </h1>
      <p className="page-sub">¿Necesitas ayuda? Estamos aquí para ti.</p>

      {chatUrl ? (
        <a href={chatUrl} target="_blank" rel="noreferrer" className="card support-cta">
          <div className="support-cta-title">
            <span aria-hidden="true">💬</span> Soporte por WhatsApp
          </div>
          <ul className="support-cta-list">
            <li>Respuesta en minutos</li>
            <li>Atención 24/7</li>
            <li>Te ayudamos en todo el proceso</li>
          </ul>
          <span className="btn primary wide">Chatear ahora →</span>
        </a>
      ) : (
        <div className="card alert warn">
          El chat de soporte no está disponible en este momento. Escríbenos por correo más abajo.
        </div>
      )}

      <div className="support-stats">
        <div className="card support-stat">
          <div className="trust-icon">🕐</div>
          <div className="mini-title">Tiempo de respuesta</div>
          <p className="hint">1 - 5 min.</p>
        </div>
        <div className="card support-stat">
          <div className="trust-icon">🌙</div>
          <div className="mini-title">Atención 24/7</div>
          <p className="hint">Siempre activos</p>
        </div>
        <div className="card support-stat">
          <div className="trust-icon">🙋</div>
          <div className="mini-title">Asesoría personalizada</div>
          <p className="hint">Te guiamos</p>
        </div>
      </div>

      <h2 className="section-title">Preguntas frecuentes</h2>

      <details className="card faq-item">
        <summary>¿Cómo recargo mis diamantes?</summary>
        <p>
          Elige tu paquete, escribe tu ID de Free Fire y confirma que el nombre que te mostramos
          es el tuyo. Después paga{cardEnabled ? ' con tarjeta o' : ''} por transferencia — en
          cuanto se confirme el pago, la recarga entra sola a tu cuenta.
        </p>
      </details>

      <details className="card faq-item">
        <summary>¿Cuánto tarda en llegar mi recarga?</summary>
        <p>
          {cardEnabled && 'Pagando con tarjeta, casi siempre son segundos. '}
          Pagando por transferencia, en cuanto validamos tu comprobante — normalmente unos
          minutos, pero puede tardar más si escribes fuera de horario. Puedes seguir el estado en
          cualquier momento desde tu enlace de pedido.
        </p>
      </details>

      <details className="card faq-item">
        <summary>¿Necesito dar mi contraseña?</summary>
        <p>
          Nunca. La recarga entra directo a tu cuenta con tu ID de jugador — no necesitamos, ni
          queremos, tus datos de acceso a Free Fire.
        </p>
      </details>

      <details className="card faq-item">
        <summary>¿Qué métodos de pago aceptan?</summary>
        <p>
          Transferencia bancaria y depósito en OXXO
          {cardEnabled ? ', además de tarjeta de crédito o débito' : ''}. Los datos para pagar
          aparecen al momento de comprar.
        </p>
      </details>

      <details className="card faq-item">
        <summary>¿Qué hago si no llega mi recarga?</summary>
        <p>
          Escríbenos por WhatsApp con tu número de pedido. Si algo salió mal, ya lo estamos
          revisando de tu lado antes de que nos escribas — pero contactarnos siempre ayuda a
          resolverlo más rápido.
        </p>
      </details>

      <div className="support-actions">
        {contactEmail && (
          <a href={`mailto:${contactEmail}`} className="btn wide">
            ✉️ Enviar correo
            <span className="hint" style={{ display: 'block' }}>
              {contactEmail}
            </span>
          </a>
        )}
        {problemUrl && (
          <a href={problemUrl} target="_blank" rel="noreferrer" className="btn wide">
            ⚠️ Reportar un problema
            <span className="hint" style={{ display: 'block' }}>
              Te ayudamos
            </span>
          </a>
        )}
      </div>
    </main>
  );
}
