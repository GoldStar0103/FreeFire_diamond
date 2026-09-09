import Link from 'next/link';
import { listOrders, type OrderFilter } from '@levelup/db';
import { db } from '../../../lib/db';
import { requireSession } from '../../../lib/session';
import { dateTime, mxn, orderStatusLabel, statusTone } from '../../../lib/format';

export const dynamic = 'force-dynamic';

const FILTERS: Array<{ value: OrderFilter; label: string }> = [
  { value: 'all', label: 'Todos' },
  { value: 'needs_attention', label: 'Requieren atención' },
  { value: 'pending_payment', label: 'Esperando pago' },
  { value: 'processing', label: 'Procesando' },
  { value: 'completed', label: 'Completados' },
];

const PAGE_SIZE = 50;

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ filtro?: string; q?: string; p?: string }>;
}) {
  await requireSession();
  const params = await searchParams;

  const filter = (FILTERS.find((f) => f.value === params.filtro)?.value ?? 'all') as OrderFilter;
  const search = params.q?.trim() ?? '';
  const page = Math.max(1, Number(params.p) || 1);

  const { rows, total } = await listOrders(db, {
    filter,
    ...(search ? { search } : {}),
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const linkTo = (next: Record<string, string | number>) => {
    const q = new URLSearchParams();
    if (filter !== 'all') q.set('filtro', filter);
    if (search) q.set('q', search);
    for (const [k, v] of Object.entries(next)) q.set(k, String(v));
    return `/pedidos?${q.toString()}`;
  };

  return (
    <>
      <div className="row">
        <h1 style={{ marginBottom: 0 }}>Pedidos</h1>
        <div className="spacer" />
        <Link className="btn primary" href="/pedidos/nuevo">
          Nuevo pedido manual
        </Link>
      </div>
      <p className="subtitle">{total} pedido(s)</p>

      <form className="row" style={{ marginBottom: 14 }}>
        {/* Search matches the order number or the Free Fire ID — the two things
            a customer actually quotes over WhatsApp. */}
        <input
          name="q"
          type="text"
          defaultValue={search}
          placeholder="Buscar por número de pedido o ID de jugador"
          style={{ maxWidth: 340 }}
        />
        <select name="filtro" defaultValue={filter}>
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <button className="btn" type="submit">
          Buscar
        </button>
      </form>

      {rows.length === 0 ? (
        <div className="card empty">No hay pedidos con este filtro.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Pedido</th>
                <th>Combo</th>
                <th>ID jugador</th>
                <th>Estado</th>
                <th className="num">Entregado</th>
                <th className="num">Monto</th>
                <th>Fecha</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.orderId}>
                  <td className="mono">
                    <Link href={`/pedidos/${o.orderId}`} style={{ color: 'var(--accent)' }}>
                      {o.orderNumber}
                    </Link>
                  </td>
                  <td>{o.comboName}</td>
                  <td className="mono">{o.playerId}</td>
                  <td>
                    <span className={`badge ${statusTone(o.status)}`}>
                      {orderStatusLabel(o.status)}
                    </span>
                  </td>
                  <td className="num">
                    {o.itemsDelivered}/{o.itemsTotal}
                  </td>
                  <td className="num">{mxn(o.priceMxnCents)}</td>
                  <td style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                    {dateTime(o.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <div className="row" style={{ marginTop: 14 }}>
          {page > 1 && (
            <Link className="btn sm" href={linkTo({ p: page - 1 })}>
              Anterior
            </Link>
          )}
          <span style={{ color: 'var(--muted)', fontSize: 13 }}>
            Página {page} de {pages}
          </span>
          {page < pages && (
            <Link className="btn sm" href={linkTo({ p: page + 1 })}>
              Siguiente
            </Link>
          )}
        </div>
      )}
    </>
  );
}
