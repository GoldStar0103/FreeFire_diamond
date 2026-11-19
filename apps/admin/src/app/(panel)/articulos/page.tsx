import { DrizzleItemCatalogAdminStore, getArsRate, getItemMarkupPercent } from '@levelup/db';
import { getDb } from '../../../lib/db';
import { requireSession } from '../../../lib/session';
import { mxn } from '../../../lib/format';
import { renameItem, toggleItemActive } from './actions';

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
  const [items, arsRate, markupPercent] = await Promise.all([
    new DrizzleItemCatalogAdminStore(db).listItemsForAdmin(),
    getArsRate(db),
    getItemMarkupPercent(db),
  ]);

  return (
    <>
      <h1 style={{ marginBottom: 0 }}>Artículos (RocketPass)</h1>
      <p className="subtitle">
        El catálogo se sincroniza solo desde RocketPass — aquí solo decides cuáles se venden y
        cómo se llaman en la tienda. El precio al cliente usa el tipo de cambio y el margen de{' '}
        <a href="/ajustes">Ajustes</a> (ahora mismo: {arsRate} MXN por ARS, +{markupPercent}%).
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
              <th className="num">Precio ARS</th>
              <th className="num">Precio al cliente</th>
              <th>Stock</th>
              <th>Disponible en RocketPass</th>
              <th>Estado</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const costMxnCents = Math.round(item.priceArs * arsRate * 100);
              const salePriceMxnCents = Math.round(costMxnCents * (1 + markupPercent / 100));
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
                  <td className="num">${item.priceArs.toFixed(2)} ARS</td>
                  <td className="num" style={{ color: 'var(--muted)' }}>{mxn(salePriceMxnCents)}</td>
                  <td>{stockLabel(item.stockByRegion)}</td>
                  <td>
                    {item.rocketpassAvailable ? (
                      <span className="badge ok">Sí</span>
                    ) : (
                      <span className="badge bad">No</span>
                    )}
                  </td>
                  <td>
                    {item.active ? (
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
