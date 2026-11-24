'use client';

import { useEffect } from 'react';

/**
 * Mounted once, app-wide — not just inside the card checkout.
 *
 * "Failed to find Server Action ... This request might be from an older or
 * newer deployment" happens whenever a tab was open across a redeploy and
 * then calls ANY server action (a form's own `action`, a `useActionState`
 * submit, a Brick's onSubmit) — the action id that tab's already-loaded page
 * references no longer exists in the new build. card-payment-brick.tsx
 * handles this for the one call site that awaits its own action directly and
 * can catch the rejection locally; every other server action on the site
 * (the SPEI form, "Continuar pago", etc.) throws this as an *unhandled*
 * promise rejection instead, which that local fix can never see. Confirmed
 * in production 2026-11-24: a customer hit exactly this on a path the
 * narrower, component-local fix didn't cover.
 *
 * No charge or request of any kind is ever attempted when this fires — it
 * fails before reaching our server at all — so a reload is strictly a
 * recovery, never a retry of something that might have already happened.
 */
export function StaleDeployRecovery() {
  useEffect(() => {
    const handler = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const message = reason instanceof Error ? reason.message : String(reason);
      if (message.includes('Failed to find Server Action')) {
        window.location.reload();
      }
    };
    window.addEventListener('unhandledrejection', handler);
    return () => window.removeEventListener('unhandledrejection', handler);
  }, []);

  return null;
}
