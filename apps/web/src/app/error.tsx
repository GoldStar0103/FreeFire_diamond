'use client';

/**
 * What a customer sees when something breaks.
 *
 * Without this they get Next's default error screen — in production a bare
 * "Application error: a client-side exception has occurred". To someone who
 * just transferred 5,850 pesos to a store they found on TikTok, that reads
 * exactly like being scammed. The single most important thing on this page is
 * therefore not the retry button; it is the sentence telling them their order
 * exists and their money is accounted for.
 *
 * No error text is shown. `digest` is a hash Next generates for the real error,
 * which stays in the server logs — enough to correlate a customer's report with
 * what actually happened, without putting a stack trace in front of them.
 */

import { useEffect } from 'react';

export default function StorefrontError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[storefront] unhandled error', error.digest ?? error.message);
  }, [error]);

  // No WhatsApp button here on purpose. The support number is a server-only
  // env var, and the root layout — which survives this boundary — already puts
  // a Soporte link in the footer. Duplicating it as NEXT_PUBLIC_ would bake a
  // second copy into the client bundle at build time and let the two drift.
  return (
    <main className="page narrow">
      <div className="card status-card bad">
        <div className="status-label">Algo salió mal</div>
        <p className="status-detail">
          Tuvimos un problema al cargar esta página. No es culpa tuya.
        </p>
      </div>

      <div className="card">
        <p style={{ margin: 0, fontSize: 15 }}>
          <strong>Si ya hiciste tu pago, tu pedido está registrado.</strong> Nada se pierde por
          este error. Puedes consultarlo con tu número de pedido y tu ID de jugador.
        </p>
      </div>

      <button className="btn primary wide" onClick={reset} type="button">
        Reintentar
      </button>

      <a className="btn wide" href="/pedidos" style={{ marginTop: 10 }}>
        Consultar mi pedido
      </a>

      {error.digest && (
        // Not an error message — a reference. It turns "no me cargó la página"
        // into something findable in the logs.
        <p className="hint center">Código de referencia: {error.digest}</p>
      )}

      <a className="back center" href="/">
        ← Volver a la tienda
      </a>
    </main>
  );
}
