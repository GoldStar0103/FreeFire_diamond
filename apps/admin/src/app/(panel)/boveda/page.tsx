import { listActiveCombosForOffers, listVaultOffersForAdmin } from '@levelup/db';
import { getDb } from '../../../lib/db';
import { requireSession } from '../../../lib/session';
import { mxn } from '../../../lib/format';
import { deleteOffer, toggleOffer } from './actions';
import { OfferForm } from './offer-form';

export const dynamic = 'force-dynamic';

export default async function BovedaPage() {
  await requireSession();
  const db = getDb();
  const [offers, combos] = await Promise.all([listVaultOffersForAdmin(db), listActiveCombosForOffers(db)]);

  return (
    <>
      <h1>La Bóveda</h1>
      <p className="subtitle">
        Ofertas que un jugador ve al desbloquear la Bóveda al completar el Level Pass. Hasta 6
        activas a la vez, por recomendación del diseño original.
      </p>

      <div className="card">
        <h2 className="mini-title">Agregar oferta</h2>
        {combos.length === 0 ? (
          <p className="hint">No hay combos activos todavía — crea uno en Combos primero.</p>
        ) : (
          <OfferForm combos={combos} />
        )}
      </div>

      {offers.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          {offers.length > 6 && (
            <div className="alert warn" style={{ marginBottom: 12 }}>
              Hay {offers.filter((o) => o.active).length} ofertas activas — el diseño original
              recomienda un máximo de 6 a la vez.
            </div>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Combo</th>
                  <th className="num">Precio público</th>
                  <th className="num">Precio Bóveda</th>
                  <th className="num">Descuento</th>
                  <th>Estado</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {offers.map((o) => {
                  const discountPct = Math.round((1 - o.vaultPriceMxnCents / o.publicPriceMxnCents) * 100);
                  return (
                    <tr key={o.id}>
                      <td>{o.comboName}</td>
                      <td className="num">{mxn(o.publicPriceMxnCents)}</td>
                      <td className="num">{mxn(o.vaultPriceMxnCents)}</td>
                      <td className="num">
                        <span className="badge ok">-{discountPct}%</span>
                      </td>
                      <td>
                        <span className={`badge ${o.active ? 'ok' : 'muted'}`}>{o.active ? 'Activa' : 'Apagada'}</span>
                      </td>
                      <td>
                        <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                          <form action={toggleOffer}>
                            <input type="hidden" name="id" value={o.id} />
                            <input type="hidden" name="active" value={String(!o.active)} />
                            <button className="btn sm" type="submit">
                              {o.active ? 'Apagar' : 'Activar'}
                            </button>
                          </form>
                          <form action={deleteOffer}>
                            <input type="hidden" name="id" value={o.id} />
                            <button className="btn sm danger" type="submit">
                              Eliminar
                            </button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
