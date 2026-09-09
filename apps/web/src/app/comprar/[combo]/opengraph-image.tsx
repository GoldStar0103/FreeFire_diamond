import { ImageResponse } from 'next/og';
import { getStorefrontCombo } from '@levelup/db';
import { db } from '../../../lib/server';
import { diamonds, mxn } from '../../../lib/format';

/**
 * The preview card for a single offer.
 *
 * This is the one that earns its keep. Offers get shared into WhatsApp groups
 * one link at a time, and a card reading "Pack Insano · $860" over a large
 * diamond count does the selling before anyone taps. The generic site card
 * cannot; it says nothing about the thing being shared.
 *
 * Two satori rules are load-bearing here, and both fail at render time rather
 * than at build time — so getting them wrong ships a broken preview rather
 * than a broken build:
 *
 *   1. Every div with more than one child needs an explicit `display`. Text
 *      interpolated as `{a} · {b}` counts as three children.
 *   2. Fragments are not transparent to layout. Children of a `<>` do not join
 *      the parent's flex column; they end up overlapping in a row. Hence the
 *      explicit containers below and the early return instead of a ternary.
 *
 * No emoji: satori resolves those by fetching from an external CDN at render
 * time, and fails silently when it cannot.
 */

export const alt = 'Recarga de diamantes para Free Fire';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const BACKDROP = {
  width: '100%',
  height: '100%',
  display: 'flex',
  flexDirection: 'column' as const,
  alignItems: 'center',
  justifyContent: 'center',
  background: 'linear-gradient(135deg, #0b0d18 0%, #1b1740 55%, #0b0d18 100%)',
  color: '#eef0fb',
  fontFamily: 'sans-serif',
};

const WORDMARK = { fontSize: 28, letterSpacing: 10, color: '#8b91b5', fontWeight: 700 };

export default async function Image({ params }: { params: Promise<{ combo: string }> }) {
  const { combo: comboKey } = await params;
  const combo = await getStorefrontCombo(db, comboKey);

  // An unknown or retired key still gets a valid, on-brand image. A scraper
  // that receives an error makes the whole link look dead.
  if (!combo) {
    return new ImageResponse(
      (
        <div style={BACKDROP}>
          <div style={WORDMARK}>LEVELUP STORE</div>
          <div style={{ fontSize: 88, fontWeight: 800, marginTop: 22, letterSpacing: -3 }}>
            RECARGAS AL INSTANTE
          </div>
          <div style={{ fontSize: 34, color: '#8b91b5', marginTop: 14 }}>
            Diamantes de Free Fire directo a tu cuenta
          </div>
        </div>
      ),
      size,
    );
  }

  return new ImageResponse(
    (
      <div style={BACKDROP}>
        <div style={WORDMARK}>LEVELUP STORE</div>

        <div
          style={{
            fontSize: 116,
            fontWeight: 800,
            color: '#a78bfa',
            marginTop: 24,
            letterSpacing: -4,
          }}
        >
          {diamonds(combo.advertisedDiamonds)}
        </div>

        <div style={{ fontSize: 34, color: '#8b91b5' }}>diamantes para Free Fire</div>

        <div
          style={{
            fontSize: 46,
            fontWeight: 700,
            marginTop: 34,
            padding: '14px 40px',
            borderRadius: 999,
            background: '#151829',
            border: '1px solid #2a2f4a',
          }}
        >
          {`${combo.name} · ${mxn(combo.priceMxnCents)}`}
        </div>

        <div style={{ fontSize: 27, color: '#8b91b5', marginTop: 30 }}>
          Entrega automática · Pago seguro · Sin contraseñas
        </div>
      </div>
    ),
    size,
  );
}
