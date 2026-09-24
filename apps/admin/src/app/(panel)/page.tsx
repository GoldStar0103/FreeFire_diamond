import Link from 'next/link';
import { getDashboardStats, getPaymentDetails, listStuckGatewayPayments } from '@levelup/db';
import { getDb } from '../../lib/db';
import { requireSession } from '../../lib/session';
import { getProvider } from '../../lib/provider';
import { mxn, usd } from '../../lib/format';

export const dynamic = 'force-dynamic';

/**
 * Read live, never cached — this is the same number `getBalance()` reports to
 * the worker's low-balance alert, and a client once worried it had gone
 * stale after a top-up specifically because there was nowhere in the panel
 * to just look at it themselves. Null means the provider could not be
 * reached just now, not that the balance is zero — never conflate the two.
 */
async function providerBalanceUsd(): Promise<number | null> {
  try {
    return (await getProvider().getBalance()) / 10_000;
  } catch {
    return null;
  }
}

export default async function DashboardPage() {
  await requireSession();
  const [stats, payTo, balanceUsd, stuckGatewayPayments] = await Promise.all([
    getDashboardStats(getDb()),
    getPaymentDetails(getDb()),
    providerBalanceUsd(),
    listStuckGatewayPayments(getDb()),
  ]);
  const lowBalanceThreshold = Number(process.env.RA_LOW_BALANCE_USD ?? 100);
  const METHOD_NAME: Record<string, string> = { oxxo: 'OXXO', spei: 'SPEI' };

  return (
    <>
      <h1>Inicio</h1>
      <p className="subtitle">Resumen de hoy.</p>

      {/* All of these mean money is not being made right now, so they sit
          above the numbers rather than below them. */}
      {!payTo && (
        // First, because it is the only one that stops every sale outright.
        // The storefront will not show payment details it does not have, so
        // until this is set nobody can complete a purchase.
        <div className="alert bad">
          <strong>La tienda no puede recibir pagos.</strong> No hay una cuenta configurada, así
          que los clientes ven un aviso para escribirte por WhatsApp en lugar de los datos de
          pago.{' '}
          <Link href="/ajustes" style={{ textDecoration: 'underline' }}>
            Configúrala en Ajustes
          </Link>
          .
        </div>
      )}

      {stats.missingProducts.length > 0 && (
        <div className="alert bad">
          <strong>Faltan productos del proveedor:</strong>{' '}
          {stats.missingProducts.join(', ')} 💎. Los combos que los usan no se pueden
          entregar. Corre la sincronización del catálogo.
        </div>
      )}

      {stuckGatewayPayments.length > 0 && (
        // Not "esperando aprobación" — there is nothing here to approve, and
        // showing these in Aprobaciones was the exact mistake fixed after a
        // real incident. This is purely informational: OXXO/SPEI settle
        // themselves once Stripe hears from the bank/store, which can
        // genuinely take a few hours. Past ~12h with no movement is when it
        // stops being normal and is worth a message to Stripe support.
        <div className={`alert ${stuckGatewayPayments.some((p) => p.pendingHours >= 12) ? 'bad' : 'warn'}`}>
          <strong>{stuckGatewayPayments.length} pago(s) de OXXO/SPEI sin confirmar todavía.</strong>{' '}
          Es normal que tarden unas horas — Stripe los confirma solo en cuanto el banco o la
          tienda OXXO le avisa. Si alguno lleva más de 12 horas, vale la pena escribirle a
          soporte de Stripe con ese número de pedido.
          <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
            {stuckGatewayPayments.map((p) => (
              <li key={p.orderNumber}>
                {p.orderNumber} — {METHOD_NAME[p.method] ?? p.method} — {p.pendingHours}h
              </li>
            ))}
          </ul>
        </div>
      )}

      {stats.inactiveCombos.length > 0 && (
        <div className="alert warn">
          <strong>{stats.inactiveCombos.length} combo(s) apagados</strong> porque entregan
          menos de lo que anuncian:{' '}
          {stats.inactiveCombos.map((c) => c.name).join(', ')}.{' '}
          <Link href="/combos" style={{ textDecoration: 'underline' }}>
            Revisar combos
          </Link>
        </div>
      )}

      <div className="stat-grid">
        <Link href="/aprobaciones" className="card">
          <div className="stat-label">Esperando aprobación</div>
          <div className={`stat-value${stats.awaitingApproval > 0 ? ' bad' : ''}`}>
            {stats.awaitingApproval}
          </div>
        </Link>

        <div className="card">
          <div className="stat-label">Procesando</div>
          <div className="stat-value">{stats.processing}</div>
        </div>

        <Link href="/pedidos?filtro=needs_attention" className="card">
          <div className="stat-label">Requieren revisión</div>
          <div className={`stat-value${stats.needsReview > 0 ? ' bad' : ''}`}>
            {stats.needsReview}
          </div>
        </Link>

        <div className="card">
          <div className="stat-label">Completados hoy</div>
          <div className="stat-value ok">{stats.completedToday}</div>
        </div>

        <div className="card">
          <div className="stat-label">Ventas brutas hoy</div>
          <div className="stat-value">{mxn(stats.revenueTodayCents)}</div>
        </div>

        <div className="card">
          <div className="stat-label">Ventas netas hoy</div>
          <div className={`stat-value${stats.netRevenueTodayCents < 0 ? ' bad' : ' ok'}`}>
            {mxn(stats.netRevenueTodayCents)}
          </div>
        </div>

        <div className="card">
          <div className="stat-label">Saldo del proveedor</div>
          <div
            className={`stat-value${
              balanceUsd === null || balanceUsd < lowBalanceThreshold ? ' bad' : ' ok'
            }`}
          >
            {balanceUsd === null ? 'No disponible' : usd(balanceUsd.toFixed(2))}
          </div>
        </div>
      </div>
      <p className="hint">
        Ventas netas = ventas brutas − costo de recargas − comisión estimada de la plataforma de
        pago. Ve el detalle completo en{' '}
        <Link href="/contabilidad" style={{ textDecoration: 'underline' }}>
          Contabilidad
        </Link>
        .
      </p>
    </>
  );
}
