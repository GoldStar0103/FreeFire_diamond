'use client';

/**
 * Last resort: an error in the root layout itself.
 *
 * This boundary replaces the whole document, so it must render its own html and
 * body, and it cannot count on the layout, the footer, or anything else having
 * worked. Styles are inline for the same reason — if the stylesheet is what
 * failed, a class name buys nothing. The colours are the theme's tokens copied
 * literally, because `var(--accent)` is defined in that stylesheet.
 *
 * Deliberately plain. The one job is to not look like a crashed site to someone
 * who has just sent money.
 */

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="es-MX">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0b0d18',
          color: '#eef0fb',
          fontFamily: 'system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
          padding: 24,
        }}
      >
        <div style={{ maxWidth: 420, textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em' }}>
            LEVELUP STORE
          </div>

          <p style={{ fontSize: 17, fontWeight: 700, marginTop: 22 }}>
            El sitio no está disponible en este momento
          </p>

          <p style={{ color: '#8b91b5', fontSize: 15, lineHeight: 1.5 }}>
            Estamos trabajando en ello.{' '}
            <strong style={{ color: '#eef0fb' }}>Si ya pagaste, tu pedido está registrado</strong> y
            se va a entregar. No necesitas volver a pagar.
          </p>

          <button
            type="button"
            onClick={reset}
            style={{
              font: 'inherit',
              fontWeight: 700,
              marginTop: 18,
              padding: '12px 22px',
              borderRadius: 10,
              border: 'none',
              background: '#8b5cf6',
              color: '#fff',
              cursor: 'pointer',
            }}
          >
            Reintentar
          </button>

          {error.digest && (
            <p style={{ color: '#5c6288', fontSize: 12, marginTop: 20 }}>
              Código de referencia: {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
