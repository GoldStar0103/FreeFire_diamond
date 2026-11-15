'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { reportStuckGatewayRedirect } from '../app/comprar/[combo]/actions';
import { isInAppBrowser } from './in-app-browser';

/** How many 400ms checks to give the popup before deciding it's stuck. */
const STUCK_POPUP_POLL_MS = 400;
const STUCK_POPUP_MAX_ATTEMPTS = 4;

/** What any gateway-opening server action's state needs to carry for this hook. */
export interface GatewayRedirectState {
  checkoutUrl?: string;
  orderPageUrl?: string;
}

/**
 * Send the customer to Stripe/Mercado Pago in a new tab, keeping this one on
 * the order page — the gateways' own hosted confirmation for OXXO/SPEI does
 * not redirect back on its own, so leaving the whole page there was a dead
 * end.
 *
 * The tab has to be opened *synchronously* inside the submit handler, before
 * the server action's network round trip — opening one after the fact, once
 * `checkoutUrl` arrives, is exactly the pattern browsers' popup blockers
 * exist to stop, since by then there is no user gesture left to point to.
 * Opening a blank tab now and pointing it at the real URL once it arrives
 * keeps it inside that gesture.
 *
 * `isInAppBrowser` below skips the popup for *known* offenders (Instagram,
 * Facebook, TikTok — see `lib/in-app-browser.ts`), since their in-app
 * WKWebView/WebView hands `window.open()` off to a separate process this
 * page can no longer drive. But that list is not exhaustive — WhatsApp, this
 * store's single biggest traffic source (see root layout), doesn't brand its
 * UA at all and slipped through undetected (2026-11-01), leaving a customer
 * staring at a permanently blank popup. So this also verifies the popup
 * actually navigated: if it is still on `about:blank` after a few checks,
 * the write to `.location.href` silently did nothing — same failure, just an
 * app we can't name in advance — and it recovers by sending the whole tab,
 * regardless of which browser caused it.
 *
 * Shared between the combo checkout (`comprar/[combo]/checkout.tsx`) and the
 * order page's "Continuar pago" button (`pedido/[orderNumber]`) — both open a
 * fresh gateway session for an order the same way, new or resumed.
 */
export function useStripeTabRedirect(state: GatewayRedirectState) {
  const popup = useRef<Window | null>(null);
  const router = useRouter();

  useEffect(() => {
    if (!state.checkoutUrl) return;
    const checkoutUrl = state.checkoutUrl;
    const orderPageUrl = state.orderPageUrl;
    const win = popup.current;

    if (!win || win.closed) {
      window.location.href = checkoutUrl;
      return;
    }

    win.location.href = checkoutUrl;

    let attempts = 0;
    const poll = window.setInterval(() => {
      attempts += 1;
      // The customer closed the popup themselves — nothing to recover.
      if (win.closed) {
        window.clearInterval(poll);
        return;
      }

      // Reading `.location.href` throws once the popup has actually
      // navigated to the gateway's cross-origin page — that's success.
      let stuck: boolean;
      try {
        stuck = win.location.href === 'about:blank';
      } catch {
        stuck = false;
      }

      if (!stuck) {
        window.clearInterval(poll);
        if (orderPageUrl) router.push(orderPageUrl);
        return;
      }

      if (attempts >= STUCK_POPUP_MAX_ATTEMPTS) {
        window.clearInterval(poll);
        win.close();
        window.location.href = checkoutUrl;
        // Fire-and-forget: tells a human which browser needed recovering,
        // without delaying it. The customer is already unstuck either way.
        reportStuckGatewayRedirect(navigator.userAgent).catch(() => {});
      }
    }, STUCK_POPUP_POLL_MS);

    // Cancel a still-pending poll if the URL changes again (resubmit) or the
    // component unmounts — otherwise a stale timer can fire later and close
    // or redirect a tab that's no longer the one it was checking.
    return () => window.clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.checkoutUrl, state.orderPageUrl]);

  return () => {
    // Left null on purpose for known in-app browsers — the effect above
    // already falls back to sending the whole tab whenever there is no
    // usable popup, and recovers on its own for the ones this can't name.
    if (isInAppBrowser(navigator.userAgent)) return;
    popup.current = window.open('about:blank', '_blank');
  };
}

/**
 * Shown right above the button on any form that is about to send the
 * customer to the gateway's own page.
 *
 * One message for everyone, not branched on `isInAppBrowser` — that list is
 * known to be incomplete (see `useStripeTabRedirect`'s comment), so a
 * message that promised "pestaña nueva" only when the check *failed* to
 * detect the browser would have been wrong for exactly the customers most
 * likely to need it. This wording holds regardless of which path actually
 * runs.
 */
export function GatewayTabNotice({ provider }: { provider: string }) {
  return (
    <div className="alert warn" style={{ marginBottom: 12 }}>
      🔒 Al confirmar te llevamos a pagar en la página segura de {provider}. Puede abrirse en una
      pestaña nueva o seguir en esta misma pantalla, según tu navegador — cuando termines, regresa
      aquí para ver el estado de tu pedido.
    </div>
  );
}
