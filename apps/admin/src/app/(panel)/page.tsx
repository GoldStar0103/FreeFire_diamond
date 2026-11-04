import Link from 'next/link';
import {
  getActiveProvider,
  getDashboardStats,
  getEmergencyMode,
  getPaymentDetails,
  listStuckGatewayPayments,
  listWalletResolvedDeliveries,
} from '@levelup/db';
import type { ProviderName } from '@levelup/provider';
import { getDb } from '../../lib/db';
import { requireSession } from '../../lib/session';
import { getProvider } from '../../lib/provider';
import { dateTime, diamonds, mxn, usd } from '../../lib/format';
import { dismissStuckGatewayPaymentAction, dismissWalletResolvedDeliveryAction } from './actions';

export const dynamic = 'force-dynamic';

const PROVIDER_LABEL: Record<ProviderName, string> = {
  recargas_america: 'RecargasAmérica',
  central_one: 'Central One',
};

/**
 * Read live, never cached — this is the same number `getBalance()` reports to
 * the worker's low-balance alert, and a client once worried it had gone
 * stale after a top-up specifically because there was nowhere in the panel
 * to just look at it themselves. Null means the provider could not be
 * reached just now, not that the balance is zero — never conflate the two.
 */
async function providerBalanceUsd(name: ProviderName): Promise<number | null> {
  try {
    return (await getProvider(name).getBalance()) / 10_000;
  } catch {
    return null;
  }
}

export default async function DashboardPage() {
  await requireSession();
  const [
    stats,
    payTo,
    raBalanceUsd,
    centralOneBalanceUsd,
    activeProvider,
    stuckGatewayPayments,
    walletResolvedDeliveries,
    emergencyMode,
  ] = await Promise.all([
    getDashboardStats(getDb()),
    getPaymentDetails(getDb()),
    providerBalanceUsd('recargas_america'),
    providerBalanceUsd('central_one'),
    getActiveProvider(getDb()),
    listStuckGatewayPayments(getDb()),
    listWalletResolvedDeliveries(getDb()),
    getEmergencyMode(getDb()),
  ]);
  const lowBalanceThreshold = Number(process.env.RA_LOW_BALANCE_USD ?? 100);
  const METHOD_NAME: Record<string, string> = { oxxo: 'OXXO', spei: 'SPEI' };
  const GATEWAY_NAME: Record<string, string> = { stripe: 'Stripe', mercadopago: 'Mercado Pago' };

  return (
    <>
      <h1>Inicio</h1>
      <p className="subtitle">Resumen de hoy.</p>

      {/* All of these mean money is not being made right now, so they sit
          above the numbers rather than below them. */}
      {emergencyMode.enabled && (
        // Above even `!payTo` — this is the one state the owner must not
        // forget is on, since every new order silently stops at "Requieren
        // revisión" instead of being delivered automatically.
        <div className="alert bad">
          <strong>Modo de emergencia activo.</strong> Los pedidos nuevos no se están entregando
          automáticamente — quedan en revisión para que los entregues tú a mano.{' '}
          <Link href="/ajustes" style={{ textDecoration: 'underline' }}>
            Desactivarlo en Ajustes
          </Link>
          .
        </div>
      )}

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
        // themselves once the gateway hears from the bank/store, which can
        // genuinely take a few hours. Past ~12h with no movement is when it
        // stops being normal and is worth a message to the gateway's support.
        <div className={`alert ${stuckGatewayPayments.some((p) => p.pendingHours >= 12) ? 'bad' : 'warn'}`}>
          <strong>{stuckGatewayPayments.length} pago(s) de OXXO/SPEI sin confirmar todavía.</strong>{' '}
          Es normal que tarden unas horas — el sistema de pago los confirma solo en cuanto el
          banco o la tienda OXXO le avisa. Si alguno lleva más de 12 horas, vale la pena
          escribirle a soporte con ese número de pedido.
          <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
            {stuckGatewayPayments.map((p) => (
              <li key={p.paymentId} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>
                  {p.orderNumber} — {GATEWAY_NAME[p.gateway] ?? p.gateway} —{' '}
                  {METHOD_NAME[p.method] ?? p.method} — {p.pendingHours}h
                </span>
                <form action={dismissStuckGatewayPaymentAction}>
                  <input type="hidden" name="paymentId" value={p.paymentId} />
                  <button type="submit" className="btn sm ghost">
                    ✓ Revisado
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </div>
      )}

      {walletResolvedDeliveries.length > 0 && (
        // Not a payment problem — the customer paid and the provider's
        // wallet was charged. This is specifically the case where a
        // recharge call errored out (a real 502, no clean response) and got
        // marked delivered only because the wallet balance dropped by the
        // expected amount. That inference is usually right — retrying
        // instead risks double-delivering diamonds that can never be taken
        // back — but a real incident (2026-09-25) proved it can be wrong: a
        // customer never received theirs despite this exact resolution.
        // Worth a quick manual confirmation with each customer rather than
        // waiting for one to complain.
        <div className="alert warn">
          <strong>
            {walletResolvedDeliveries.length} entrega(s) confirmada(s) solo por saldo, no por
            respuesta del proveedor.
          </strong>{' '}
          El proveedor tuvo un error justo en la llamada, pero el saldo bajó lo esperado, así que
          se marcaron como entregadas. Casi siempre es correcto, pero vale la pena confirmar con
          estos clientes que sí recibieron sus diamantes.
          <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
            {walletResolvedDeliveries.map((d) => (
              <li key={d.orderItemId} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>
                  {d.orderNumber} — ID {d.playerId} — {diamonds(d.diamondsBase)} 💎
                  {d.costUsd ? ` — ${usd(d.costUsd)}` : ''} — {dateTime(d.settledAt)}
                </span>
                <form action={dismissWalletResolvedDeliveryAction}>
                  <input type="hidden" name="orderItemId" value={d.orderItemId} />
                  <button type="submit" className="btn sm ghost">
                    ✓ Revisado
                  </button>
                </form>
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
          <div className="stat-label">
            Saldo {PROVIDER_LABEL.recargas_america}
            {activeProvider.provider === 'recargas_america' ? ' · activo' : ''}
          </div>
          <div
            className={`stat-value${
              raBalanceUsd === null || raBalanceUsd < lowBalanceThreshold ? ' bad' : ' ok'
            }`}
          >
            {raBalanceUsd === null ? 'No disponible' : usd(raBalanceUsd.toFixed(2))}
          </div>
        </div>

        <div className="card">
          <div className="stat-label">
            Saldo {PROVIDER_LABEL.central_one}
            {activeProvider.provider === 'central_one' ? ' · activo' : ''}
          </div>
          <div className={`stat-value${centralOneBalanceUsd === null ? ' bad' : ''}`}>
            {centralOneBalanceUsd === null ? 'No disponible' : usd(centralOneBalanceUsd.toFixed(2))}
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
