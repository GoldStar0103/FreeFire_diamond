import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAdminCustomerDetail } from '@levelup/db';
import { getDb } from '../../../../lib/db';
import { requireSession } from '../../../../lib/session';
import { dateTime, diamonds, mxn, orderStatusLabel, statusTone } from '../../../../lib/format';

export const dynamic = 'force-dynamic';

const CHECKPOINT_LABEL: Record<string, { text: string; tone: string }> = {
  granted: { text: 'Entregada', tone: 'ok' },
  pending: { text: 'Pendiente', tone: 'warn' },
  reversed: { text: 'Revertida', tone: 'muted' },
};

export default async function ClienteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;
  const customer = await getAdminCustomerDetail(getDb(), id);
  if (!customer) notFound();

  const season = customer.season;

  return (
    <>
      <p className="subtitle" style={{ marginBottom: 4 }}>
        <Link href="/clientes" style={{ textDecoration: 'underline' }}>
          ← Clientes
        </Link>
      </p>
      <h1 style={{ marginBottom: 0 }}>{customer.displayName ?? 'Jugador'}</h1>
      <p className="subtitle">
        ID ligado <span className="mono">{customer.playerId}</span> · {customer.email} · desde{' '}
        {dateTime(customer.memberSince)} · {customer.badgeCount} insignia
        {customer.badgeCount === 1 ? '' : 's'}
      </p>

      {season ? (
        <>
          <h2 className="section-title">Temporada {season.seasonNumber}</h2>
          <div className="stat-grid">
            <div className="card">
              <div className="stat-label">Level Points</div>
              <div className="stat-value">{season.lp.toLocaleString('es-MX')}</div>
            </div>
            <div className="card">
              <div className="stat-label">💎 de la temporada</div>
              <div className="stat-value">{diamonds(season.seasonalDiamonds)}</div>
            </div>
            <div className="card">
              <div className="stat-label">Posición</div>
              <div className="stat-value">{season.rank ? `#${season.rank}` : '—'}</div>
            </div>
            <div className="card">
              <div className="stat-label">Bóveda</div>
              <div className="stat-value">
                {season.vault.active ? (
                  <span className="badge ok">Abierta</span>
                ) : (
                  <span className="badge muted">Cerrada</span>
                )}
              </div>
              {season.vault.active && season.vault.expiresAt && (
                <div className="hint">hasta {dateTime(season.vault.expiresAt)}</div>
              )}
            </div>
          </div>

          {/*
            Admin-only. Everything in this card is on the spec's "never show
            the customer" list — it is the profit this person generated and
            what their rewards cost against it.
          */}
          <div className="card" style={{ marginTop: 16 }}>
            <h2 className="mini-title">Economía (solo interno)</h2>
            <p className="subtitle">
              Nunca se le muestra al cliente. Los pedidos revertidos ya no cuentan aquí.
            </p>
            <div className="stat-grid">
              <div className="card">
                <div className="stat-label">Ganancia generada</div>
                <div className="stat-value">{mxn(customer.economics.profitGeneratedCents)}</div>
              </div>
              <div className="card">
                <div className="stat-label">Costo de sus recompensas</div>
                <div className="stat-value">{mxn(customer.economics.rewardCostCents)}</div>
              </div>
              <div className="card">
                <div className="stat-label">Ganancia retenida</div>
                <div
                  className={`stat-value${customer.economics.retainedProfitCents < 0 ? ' bad' : ' ok'}`}
                >
                  {mxn(customer.economics.retainedProfitCents)}
                </div>
              </div>
              <div className="card">
                <div className="stat-label">LP otorgados</div>
                <div className="stat-value">{customer.economics.lpAwarded.toLocaleString('es-MX')}</div>
              </div>
            </div>
          </div>

          <h2 className="section-title">Checkpoints del Level Pass</h2>
          {season.checkpoints.length === 0 ? (
            <div className="card empty">Todavía no ha llegado a ningún checkpoint.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Checkpoint</th>
                    <th>Recompensa</th>
                    <th>Estado</th>
                    <th>Llegó</th>
                    <th>Se entregó</th>
                    <th className="num">Costo interno</th>
                  </tr>
                </thead>
                <tbody>
                  {season.checkpoints.map((cp) => {
                    const label = CHECKPOINT_LABEL[cp.status] ?? { text: cp.status, tone: 'muted' };
                    return (
                      <tr key={cp.checkpointLp}>
                        <td>{cp.checkpointLp.toLocaleString('es-MX')} LP</td>
                        <td>{diamonds(cp.rewardDiamonds)} 💎</td>
                        <td>
                          <span className={`badge ${label.tone}`}>{label.text}</span>
                        </td>
                        <td>{dateTime(cp.reachedAt)}</td>
                        <td>{cp.grantedAt ? dateTime(cp.grantedAt) : '—'}</td>
                        <td className="num">{cp.status === 'granted' ? mxn(cp.internalCostCents) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <div className="alert warn">
          No hay ninguna temporada todavía, así que este cliente no tiene avance de Level Pass.
        </div>
      )}

      <h2 className="section-title">Histórico</h2>
      <div className="stat-grid">
        <div className="card">
          <div className="stat-label">💎 comprados en total</div>
          <div className="stat-value">{diamonds(customer.lifetimeDiamondsPurchased)}</div>
        </div>
        <div className="card">
          <div className="stat-label">Recargas</div>
          <div className="stat-value">{customer.lifetimeRechargeCount}</div>
        </div>
      </div>

      <h2 className="section-title">Pedidos ({customer.orders.length})</h2>
      {customer.orders.length === 0 ? (
        <div className="card empty">Sin pedidos.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Pedido</th>
                <th>Combo</th>
                <th className="num">Precio</th>
                <th>Estado</th>
                <th className="num">LP</th>
                <th className="num">Ganancia</th>
                <th>Fecha</th>
              </tr>
            </thead>
            <tbody>
              {customer.orders.map((order) => (
                <tr key={order.orderId}>
                  <td>
                    <Link href={`/pedidos/${order.orderId}`} className="mono" style={{ textDecoration: 'underline' }}>
                      {order.orderNumber}
                    </Link>
                  </td>
                  <td>{order.comboName}</td>
                  <td className="num">{mxn(order.priceMxnCents)}</td>
                  <td>
                    <span className={`badge ${statusTone(order.status)}`}>
                      {orderStatusLabel(order.status)}
                    </span>
                  </td>
                  <td className="num">
                    {order.awardedLp === null ? (
                      '—'
                    ) : order.lpReversedAt ? (
                      <span className="badge muted" title="Revertido">
                        {order.awardedLp} ✕
                      </span>
                    ) : (
                      order.awardedLp
                    )}
                  </td>
                  <td className="num">
                    {order.estimatedProfitCents === null ? '—' : mxn(order.estimatedProfitCents)}
                  </td>
                  <td>{order.completedAt ? dateTime(order.completedAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
