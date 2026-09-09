import { ImageResponse } from 'next/og';

/**
 * The preview card for the site's own link.
 *
 * Generated rather than a static file so it stays in step with the brand
 * without anyone opening an image editor, and because the per-combo card next
 * door has to be generated anyway.
 *
 * No emoji anywhere. Satori resolves emoji by fetching from an external CDN at
 * render time, which is a network dependency inside a container that has no
 * business making outbound requests to draw a picture — and when it fails it
 * fails by rendering nothing, silently.
 */

export const alt = 'LevelUp Store — Recargas de diamantes para Free Fire';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #0b0d18 0%, #1b1740 55%, #0b0d18 100%)',
          color: '#eef0fb',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ fontSize: 30, letterSpacing: 10, color: '#8b91b5', fontWeight: 700 }}>
          LEVELUP STORE
        </div>

        <div
          style={{
            display: 'flex',
            fontSize: 96,
            fontWeight: 800,
            marginTop: 18,
            letterSpacing: -3,
          }}
        >
          <span>RECARGAS&nbsp;</span>
          <span style={{ color: '#a78bfa' }}>AL INSTANTE</span>
        </div>

        <div style={{ fontSize: 36, color: '#8b91b5', marginTop: 14 }}>
          Diamantes de Free Fire directo a tu cuenta
        </div>

        <div style={{ display: 'flex', gap: 18, marginTop: 46 }}>
          {/* Accents included deliberately. The bundled font covers Latin-1,
              and misspelled Spanish on the brand's own share card would be a
              worse problem than the one that caution would avoid. */}
          {['Entrega automática', 'Pago seguro', 'Sin contraseñas'].map((label) => (
            <div
              key={label}
              style={{
                fontSize: 26,
                padding: '12px 26px',
                borderRadius: 999,
                background: '#151829',
                border: '1px solid #2a2f4a',
                color: '#eef0fb',
              }}
            >
              {label}
            </div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}
