import Link from 'next/link';
import {
  getAccountingSummary,
  mexicoCityCustomRange,
  mexicoCityDayRange,
  mexicoCityMonthRange,
  mexicoCityTodayYmd,
  mexicoCityWeekRange,
  type DateRange,
} from '@levelup/db';
import { getDb } from '../../../lib/db';
import { requireSession } from '../../../lib/session';
import { dateTime, mxn } from '../../../lib/format';

export const dynamic = 'force-dynamic';

type RangeKey = 'hoy' | 'semana' | 'mes' | 'personalizado';

const RANGES: { value: RangeKey; label: string }[] = [
  { value: 'hoy', label: 'Hoy' },
  { value: 'semana', label: 'Semana' },
  { value: 'mes', label: 'Mes' },
  { value: 'personalizado', label: 'Personalizado' },
];

function resolveRange(
  rango: RangeKey,
  desde: string | undefined,
  hasta: string | undefined,
): DateRange {
  const now = new Date();
  switch (rango) {
    case 'semana':
      return mexicoCityWeekRange(now);
    case 'mes':
      return mexicoCityMonthRange(now);
    case 'personalizado': {
      const start = desde || mexicoCityTodayYmd(now);
      const end = hasta || start;
      return mexicoCityCustomRange(start, end);
    }
    case 'hoy':
    default:
      return mexicoCityDayRange(now);
  }
}

/** MXN methods have a Spanish label the client reads, not the enum value. */
const METHOD_LABELS: Record<string, string> = {
  card: 'Tarjeta',
  oxxo: 'OXXO (Stripe)',
  spei: 'SPEI (Stripe)',
  transfer_manual: 'Transferencia/OXXO manual',
  paypal: 'PayPal',
};

export default async function ContabilidadPage({
  searchParams,
}: {
  searchParams: Promise<{ rango?: string; desde?: string; hasta?: string }>;
}) {
  await requireSession();
  const params = await searchParams;
  const rango = (RANGES.find((r) => r.value === params.rango)?.value ?? 'hoy') as RangeKey;
  const range = resolveRange(rango, params.desde, params.hasta);

  const summary = await getAccountingSummary(getDb(), range);

  return (
    <>
      <h1 style={{ marginBottom: 0 }}>Contabilidad</h1>
      <p className="subtitle">
        Ventas, costos y ganancia estimada.{' '}
        <strong>La comisión de plataforma de pago es una estimación</strong>, no el monto exacto
        que cobra Stripe.
      </p>

      <div className="row" style={{ marginBottom: 6 }}>
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
          <div className="stat-label">Ganancia estimada</div>
          <div className={`stat-value${summary.estimatedProfitCents < 0 ? ' bad' : ' ok'}`}>
            {mxn(summary.estimatedProfitCents)}
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
                  <tr key={m.method}>
                    <td>{METHOD_LABELS[m.method] ?? m.method}</td>
                    <td className="num">{m.count}</td>
                    <td className="num">{mxn(m.totalCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

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
                <th className="num">Comisión est.</th>
                <th>Fecha</th>
              </tr>
            </thead>
            <tbody>
              {summary.movements.map((m) => (
                <tr key={m.orderNumber}>
                  <td>{m.orderNumber}</td>
                  <td>{m.comboName}</td>
                  <td className="num">{mxn(m.priceMxnCents)}</td>
                  <td>{m.paymentMethod ? (METHOD_LABELS[m.paymentMethod] ?? m.paymentMethod) : '—'}</td>
                  <td className="num">{mxn(m.estimatedFeeCents)}</td>
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
