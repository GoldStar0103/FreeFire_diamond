import Link from 'next/link';
import { listCombosForAdmin, DrizzleCatalogAdminStore } from '@levelup/db';
import { ACCEPTABLE_SHORTFALL_DIAMONDS } from '@levelup/engine';
import { db } from '../../../lib/db';
import { requireSession } from '../../../lib/session';
import { diamonds, mxn, usd } from '../../../lib/format';
import { retireCampaign, toggleCombo } from './actions';

export const dynamic = 'force-dynamic';

export default async function CombosPage() {
  await requireSession();
  const [combos, campaigns] = await Promise.all([
    listCombosForAdmin(db),
    new DrizzleCatalogAdminStore(db).listCampaignOptions(),
  ]);

  // Only a gap past the rounding tolerance is a problem — the client rounds
  // flyer numbers deliberately and over-delivers on most combos.
  const shortfalls = combos.filter((c) => c.gap < -ACCEPTABLE_SHORTFALL_DIAMONDS);
  const noRecipe = combos.filter((c) => c.callCount === 0);

  return (
    <>
      <div className="row">
        <h1 style={{ marginBottom: 0 }}>Combos</h1>
        <div className="spacer" />
        <Link className="btn" href="/combos/promocion/nueva">
          Nueva promoción
        </Link>
        <Link className="btn primary" href="/combos/nuevo">
          Nuevo combo
        </Link>
      </div>
      <p className="subtitle">
        Lo que ve el cliente y las recargas que hacemos por dentro. La columna{' '}
        <strong>Diferencia</strong> es cuántos diamantes sobran o faltan contra el flyer.
      </p>

      {campaigns.length > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="row">
            <strong style={{ fontSize: 14 }}>Promociones</strong>
            <div className="spacer" />
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            {campaigns.map((c) => (
              <span key={c.key} className="row" style={{ gap: 6 }}>
                <Link className="btn sm" href={`/combos/promocion/${c.key}`}>
                  {c.name}
                </Link>
                {c.active && (
                  // The monthly rotation in one action: switches the promo and
                  // every combo under it off, without deleting anything.
                  <form action={retireCampaign}>
                    <input type="hidden" name="campaignKey" value={c.key} />
                    <button className="btn sm danger" type="submit" title="Retirar del mes">
                      Retirar
                    </button>
                  </form>
                )}
              </span>
            ))}
          </div>
        </div>
      )}

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
              <th />
            </tr>
          </thead>
          <tbody>
            {combos.map((c) => (
              <tr key={c.comboId}>
                <td style={{ color: 'var(--muted)' }}>{c.campaignName}</td>
                <td>
                  <Link href={`/combos/${c.key}`} style={{ color: 'var(--accent)' }}>
                    {c.name}
                  </Link>
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
                <td>
                  {/* Re-validated server-side on the way on, in case the
                      provider withdrew a denomination since it was saved. */}
                  <form action={toggleCombo}>
                    <input type="hidden" name="comboKey" value={c.key} />
                    <input type="hidden" name="active" value={String(!c.active)} />
                    <button className="btn sm" type="submit">
                      {c.active ? 'Apagar' : 'Activar'}
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
