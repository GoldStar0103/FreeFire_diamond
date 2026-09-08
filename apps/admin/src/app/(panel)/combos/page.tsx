import { listCombosForAdmin } from '@levelup/db';
import { db } from '../../../lib/db';
import { requireSession } from '../../../lib/session';
import { diamonds, mxn, usd } from '../../../lib/format';

export const dynamic = 'force-dynamic';

export default async function CombosPage() {
  await requireSession();
  const combos = await listCombosForAdmin(db);

  const shortfalls = combos.filter((c) => c.gap < 0);
  const noRecipe = combos.filter((c) => c.callCount === 0);

  return (
    <>
      <h1>Combos</h1>
      <p className="subtitle">
        Lo que ve el cliente y las recargas que hacemos por dentro. La columna{' '}
        <strong>Diferencia</strong> es cuántos diamantes sobran o faltan contra el flyer.
      </p>

      {shortfalls.length > 0 && (
        <div className="alert bad">
          <strong>{shortfalls.length} combo(s) entregan menos de lo que anuncian.</strong> No se
          pueden vender así — ajusta el número del flyer o agrégales otra recarga.
        </div>
      )}

      {noRecipe.length > 0 && (
        <div className="alert warn">
          <strong>{noRecipe.length} combo(s) sin receta.</strong> Corre la sincronización del
          catálogo y vuelve a cargar las promociones.
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Promoción</th>
              <th>Combo</th>
              <th className="num">Precio</th>
              <th className="num">Anuncia</th>
              <th className="num">Entrega</th>
              <th className="num">Diferencia</th>
              <th className="num">Recargas</th>
              <th className="num">Costo</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {combos.map((c) => (
              <tr key={c.comboId}>
                <td style={{ color: 'var(--muted)' }}>{c.campaignName}</td>
                <td>
                  {c.name}
                  {c.maxPerPlayer !== null && (
                    <span className="badge muted" style={{ marginLeft: 8 }}>
                      máx {c.maxPerPlayer}/jugador
                    </span>
                  )}
                </td>
                <td className="num">{mxn(c.priceMxnCents)}</td>
                <td className="num">{diamonds(c.advertisedDiamonds)}</td>
                <td className="num">{diamonds(c.deliveredDiamonds)}</td>
                <td className="num">
                  <span className={`badge ${c.gap < 0 ? 'bad' : c.gap === 0 ? 'muted' : 'ok'}`}>
                    {c.gap > 0 ? '+' : ''}
                    {diamonds(c.gap)}
                  </span>
                </td>
                <td className="num">{c.callCount}</td>
                <td className="num" style={{ color: 'var(--muted)' }}>
                  {usd(c.costUsd)}
                </td>
                <td>
                  {c.active && c.campaignActive ? (
                    <span className="badge ok">A la venta</span>
                  ) : (
                    <span className="badge muted">
                      {!c.campaignActive ? 'Promo apagada' : 'Apagado'}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
