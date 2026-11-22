import { DrizzleItemCatalogAdminStore, getArsRate } from '@levelup/db';
import { getDb } from '../../../lib/db';
import { requireSession } from '../../../lib/session';
import { mxn } from '../../../lib/format';
import { renameItem, setItemPrice, toggleItemActive } from './actions';

export const dynamic = 'force-dynamic';

const KIND_LABEL: Record<'gift' | 'membership', string> = { gift: 'Artículo', membership: 'Membresía' };

function stockLabel(stockByRegion: Record<string, number>): string {
  const entries = Object.entries(stockByRegion);
  if (entries.length === 0) return '—';
  return entries.map(([region, qty]) => `${region}: ${qty}`).join(' · ');
}

export default async function ArticulosAdminPage() {
  await requireSession();

  const db = getDb();
  const [items, arsRate] = await Promise.all([
    new DrizzleItemCatalogAdminStore(db).listItemsForAdmin(),
    getArsRate(db),
  ]);

  return (
    <>
      <h1 style={{ marginBottom: 0 }}>Artículos (RocketPass)</h1>
      <p className="subtitle">
        El catálogo se sincroniza solo desde RocketPass. El costo se calcula solo (precio ARS del
        proveedor × tipo de cambio de <a href="/ajustes">Ajustes</a>, ahora mismo {arsRate} MXN por
        ARS) — tú escribes el precio al cliente de cada artículo, igual que en Combos.
      </p>

      {items.length === 0 && (
        <div className="alert warn">
          Todavía no hay nada sincronizado. Revisa que <code>ROCKETPASS_API_KEY</code> esté
          configurada y que el worker haya corrido al menos una sincronización.
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Nombre en la tienda</th>
              <th>SKU / nombre RocketPass</th>
              <th>Tipo</th>
              <th className="num">Costo</th>
              <th className="num">Precio al cliente</th>
              <th className="num">Ganancia</th>
              <th>Stock</th>
              <th>Disponible en RocketPass</th>
              <th>Estado</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const costMxnCents = Math.round(item.priceArs * arsRate * 100);
              const marginMxnCents = item.priceMxnCents == null ? null : item.priceMxnCents - costMxnCents;
              const marginPct =
                marginMxnCents != null && item.priceMxnCents ? (marginMxnCents / item.priceMxnCents) * 100 : null;
              return (
                <tr key={item.sku}>
                  <td>
                    <form action={renameItem} className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                      <input type="hidden" name="sku" value={item.sku} />
                      <input name="displayName" defaultValue={item.displayName} className="mono" style={{ maxWidth: 180 }} />
                      <button className="btn sm" type="submit">
                        Guardar
                      </button>
                    </form>
                  </td>
                  <td style={{ color: 'var(--muted)' }}>
                    {item.sku}
                    <br />
                    <small>{item.rocketpassName}</small>
                  </td>
                  <td>{KIND_LABEL[item.kind]}</td>
                  <td className="num" style={{ color: 'var(--muted)' }}>
                    {mxn(costMxnCents)}
                    <br />
                    <small>${item.priceArs.toFixed(2)} ARS</small>
                  </td>
                  <td className="num">
                    <form action={setItemPrice} className="row" style={{ gap: 6, flexWrap: 'nowrap', justifyContent: 'flex-end' }}>
                      <input type="hidden" name="sku" value={item.sku} />
                      <input
                        name="priceMxn"
                        type="number"
                        step="0.01"
                        min="0"
                        defaultValue={item.priceMxnCents != null ? (item.priceMxnCents / 100).toFixed(2) : ''}
                        placeholder="sin precio"
                        className="mono"
                        style={{ maxWidth: 100 }}
                      />
                      <button className="btn sm" type="submit">
                        Guardar
                      </button>
                    </form>
                  </td>
                  <td className="num">
                    {marginMxnCents == null ? (
                      '—'
                    ) : (
                      <span className={marginMxnCents < 0 ? 'bad' : 'ok'}>
                        {mxn(marginMxnCents)} ({marginPct!.toFixed(1)}%)
                      </span>
                    )}
                  </td>
                  <td>{stockLabel(item.stockByRegion)}</td>
                  <td>
                    {item.rocketpassAvailable ? (
                      <span className="badge ok">Sí</span>
                    ) : (
                      <span className="badge bad">No</span>
                    )}
                  </td>
                  <td>
                    {item.priceMxnCents == null ? (
                      <span className="badge warn">Falta precio</span>
                    ) : item.active ? (
                      <span className="badge ok">A la venta</span>
                    ) : (
                      <span className="badge muted">Apagado</span>
                    )}
                  </td>
                  <td>
                    <form action={toggleItemActive}>
                      <input type="hidden" name="sku" value={item.sku} />
                      <input type="hidden" name="active" value={String(!item.active)} />
                      <button className="btn sm" type="submit">
                        {item.active ? 'Apagar' : 'Activar'}
                      </button>
                    </form>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
