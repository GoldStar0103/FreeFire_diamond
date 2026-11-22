'use client';

/**
 * Mercado Pago's device-fingerprinting script — the actual anti-fraud signal
 * on an embedded charge, not something this app computes itself. Once loaded,
 * it silently sets `window.MP_DEVICE_SESSION_ID`.
 *
 * The Card Payment Brick loads this automatically once mounted (per Mercado
 * Pago's own docs), so this helper is only needed for the SPEI form, which
 * has no Brick on screen to do it implicitly.
 */

declare global {
  interface Window {
    MP_DEVICE_SESSION_ID?: string;
  }
}

const SECURITY_SCRIPT_SRC = 'https://www.mercadopago.com/v2/security.js';
let loaded = false;

export function loadMercadoPagoSecurity(): void {
  if (loaded || typeof document === 'undefined') return;
  if (document.querySelector(`script[src="${SECURITY_SCRIPT_SRC}"]`)) {
    loaded = true;
    return;
  }
  const script = document.createElement('script');
  script.src = SECURITY_SCRIPT_SRC;
  script.setAttribute('view', 'checkout');
  document.head.appendChild(script);
  loaded = true;
}

/** Null until the script has had a moment to run — callers should read this right before submitting, not at mount. */
export function getMercadoPagoDeviceSessionId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.MP_DEVICE_SESSION_ID ?? null;
}
