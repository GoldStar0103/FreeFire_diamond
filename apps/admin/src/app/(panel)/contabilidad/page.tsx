import Link from 'next/link';
import {
  getAccountingSummary,
  getSeasonRanges,
  listManualLedgerEntries,
  mexicoCityTodayYmd,
} from '@levelup/db';
import { ManualEntries } from './manual-entries';
import { getDb } from '../../../lib/db';
import { requireSession } from '../../../lib/session';
import { dateTime, mxn } from '../../../lib/format';
import {
  methodLabel,
  RANGES,
  parseRangeKey,
  resolveRange,
  seasonFallbackNotice,
} from './range';

export const dynamic = 'force-dynamic';

export default async function ContabilidadPage({
  searchParams,
}: {
  searchParams: Promise<{ rango?: string; desde?: string; hasta?: string }>;
}) {
  await requireSession();
  const params = await searchParams;
  const rango = parseRangeKey(params.rango);
  const seasons = await getSeasonRanges(getDb());
  const range = resolveRange(rango, params.desde, params.hasta, seasons);
  const fallbackNotice = seasonFallbackNotice(rango, seasons);

  const summary = await getAccountingSummary(getDb(), range);
  const manualEntries = await listManualLedgerEntries(getDb(), range);

  const reportQuery = new URLSearchParams({ rango });
  if (params.desde) reportQuery.set('desde', params.desde);
  if (params.hasta) reportQuery.set('hasta', params.hasta);

  return (
    <>
      <h1 style={{ marginBottom: 0 }}>Contabilidad</h1>
      <p className="subtitle">
        Ventas, costos y ganancia.{' '}
        <strong>La comisión de tarjeta, SPEI y OXXO automático es una estimación</strong>, no el
        monto exacto que cobra el gateway — solo la transferencia/OXXO con comprobante manual tiene
        ganancia exacta, porque ahí no hay ninguna comisión de por medio.
      </p>

      <div className="row" style={{ marginBottom: 6, justifyContent: 'space-between' }}>
        <div className="row" style={{ margin: 0 }}>
          {RANGES.map((r) => (
            <Link
              key={r.value}
              href={`/contabilidad?rango=${r.value}`}
              className={`btn sm${rango === r.value ? ' primary' : ''}`}
            >
              {r.label}
            </Link>
          ))}
        </div>
        <a className="btn sm" href={`/contabilidad/reporte?${reportQuery.toString()}`}>
          Descargar reporte (CSV)
        </a>
      </div>

      {rango === 'personalizado' && (
        <form className="row" style={{ marginBottom: 14 }}>
          <input type="hidden" name="rango" value="personalizado" />
          <label className="field" style={{ margin: 0 }}>
            <span>Desde</span>
            <input type="date" name="desde" defaultValue={params.desde ?? mexicoCityTodayYmd()} />
          </label>
          <label className="field" style={{ margin: 0 }}>
            <span>Hasta</span>
            <input type="date" name="hasta" defaultValue={params.hasta ?? mexicoCityTodayYmd()} />
          </label>
          <button className="btn sm primary" type="submit" style={{ alignSelf: 'flex-end' }}>
            Ver
          </button>
        </form>
      )}

      {fallbackNotice && <div className="alert warn">{fallbackNotice}</div>}

      {summary.costDataIncomplete && (
        <div className="alert warn">
          A algunos pedidos de este rango les falta el costo de recarga registrado — el costo y la
          ganancia de abajo son un mínimo, no el total exacto.
        </div>
      )}

      <div className="stat-grid">
        <div className="card">
          <div className="stat-label">Ventas brutas</div>
          <div className="stat-value">{mxn(summary.grossSalesCents)}</div>
        </div>
        <div className="card">
          <div className="stat-label">Costo de recargas</div>
          <div className="stat-value">{mxn(summary.recargaCostCents)}</div>
        </div>
        <div className="card">
          <div className="stat-label">Comisión estimada</div>
          <div className="stat-value">{mxn(summary.estimatedFeeCents)}</div>
        </div>
        <div className="card">
          <div className="stat-label">Ganancia antes de recompensas</div>
          <div className={`stat-value${summary.estimatedProfitCents < 0 ? ' bad' : ' ok'}`}>
            {mxn(summary.estimatedProfitCents)}
          </div>
        </div>
      </div>

      {/*
        The Level Pass side of the P&L. Separated from the sales row above
        because these are not sales figures: they are what the rewards and any
        manual adjustments took back out, and the client needs to see the two
        apart before they are combined into the real figure.
      */}
      <div className="stat-grid">
        <div className="card">
          <div className="stat-label">Recompensas Level Pass</div>
          <div className={`stat-value${summary.levelPassRewardCostCents > 0 ? ' bad' : ''}`}>
            −{mxn(summary.levelPassRewardCostCents)}
          </div>
        </div>
        <div className="card">
          <div className="stat-label">Otros gastos</div>
          <div className={`stat-value${summary.otherExpensesCents > 0 ? ' bad' : ''}`}>
            −{mxn(summary.otherExpensesCents)}
          </div>
        </div>
        <div className="card">
          <div className="stat-label">Ganancia neta real</div>
          <div className={`stat-value${summary.realNetProfitCents < 0 ? ' bad' : ' ok'}`}>
            {mxn(summary.realNetProfitCents)}
          </div>
        </div>
        <div className="card">
          <div className="stat-label">Margen neto</div>
          <div className={`stat-value${(summary.netMarginPct ?? 0) < 0 ? ' bad' : ''}`}>
            {summary.netMarginPct === null ? '—' : `${summary.netMarginPct.toFixed(1)}%`}
          </div>
        </div>
      </div>

      <div className="stat-grid">
        <div className="card">
          <div className="stat-label">Completados</div>
          <div className="stat-value ok">{summary.orderCounts.completed}</div>
        </div>
        <div className="card">
          <div className="stat-label">Pendientes</div>
          <div className="stat-value">{summary.orderCounts.pending}</div>
        </div>
        <div className="card">
          <div className="stat-label">Cancelados</div>
          <div className="stat-value">{summary.orderCounts.cancelled}</div>
        </div>
      </div>

      {summary.totalsByMethod.length > 0 && (
        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: 16 }}>Por método de pago</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Método</th>
                  <th className="num">Pedidos</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {summary.totalsByMethod.map((m) => (
                  <tr key={`${m.method}:${m.gateway ?? ''}`}>
                    <td>{methodLabel(m.method, m.gateway)}</td>
                    <td className="num">{m.count}</td>
                    <td className="num">{mxn(m.totalCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <ManualEntries
        defaultDate={mexicoCityTodayYmd()}
        entries={manualEntries.map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          amountLabel: mxn(entry.amountCents),
          dateLabel: dateTime(entry.occurredAt),
          note: entry.note,
          createdByEmail: entry.createdByEmail,
        }))}
      />

      <h2 className="section-title">Historial de movimientos</h2>
      {summary.movements.length === 0 ? (
        <div className="card empty">Sin pedidos completados en este rango.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Pedido</th>
                <th>Combo</th>
                <th className="num">Precio</th>
                <th>Método</th>
                <th className="num">Ganancia neta</th>
                <th>Fecha</th>
              </tr>
            </thead>
            <tbody>
              {summary.movements.map((m) => (
                <tr key={m.orderNumber}>
                  <td>{m.orderNumber}</td>
                  <td>{m.comboName}</td>
                  <td className="num">{mxn(m.priceMxnCents)}</td>
                  <td>{m.paymentMethod ? methodLabel(m.paymentMethod, m.paymentGateway) : '—'}</td>
                  <td className="num">{m.netProfitCents === null ? 'N/D' : mxn(m.netProfitCents)}</td>
                  <td>{dateTime(m.completedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
