import { DrizzleCatalogAdminStore, getCurrentSeason, getLevelPassCheckpoints, listSeasonHistory } from '@levelup/db';
import { getDb } from '../../../lib/db';
import { requireSession } from '../../../lib/session';
import { dateTime, diamonds } from '../../../lib/format';
import { startSeason } from './actions';
import { CheckpointsForm } from './checkpoints-form';

export const dynamic = 'force-dynamic';

export default async function TemporadasPage() {
  await requireSession();
  const db = getDb();
  const [season, checkpoints, history, available] = await Promise.all([
    getCurrentSeason(db),
    getLevelPassCheckpoints(db),
    listSeasonHistory(db),
    new DrizzleCatalogAdminStore(db).listAvailableProducts(),
  ]);

  const checkpointRows = checkpoints.map((cp) => ({
    lp: cp.lp,
    rewardDiamonds: cp.rewardDiamonds,
    costCents: cp.costCents,
    recipe: cp.recipe.map((r) => r.diamondsBase),
  }));

  return (
    <>
      <h1>Temporadas</h1>
      <p className="subtitle">El Level Pass, el ranking y la Bóveda viven dentro de cada temporada de 60 días.</p>

      {season ? (
        <div className="card">
          <strong>Temporada {season.seasonNumber}</strong> — activa
          <div style={{ color: 'var(--muted)', marginTop: 4 }}>
            {dateTime(season.startsAt)} → {dateTime(season.endsAt)}
          </div>
        </div>
      ) : (
        <div className="alert warn">
          <strong>Todavía no hay ninguna temporada.</strong> El Level Pass, el ranking y la Bóveda no
          funcionan hasta que empiece la primera.
          <form action={startSeason} style={{ marginTop: 10 }}>
            <button className="btn primary" type="submit">
              Iniciar Temporada 1 (60 días)
            </button>
          </form>
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <h2 className="mini-title">Checkpoints del Level Pass</h2>
        <p className="subtitle">
          Cambiar estos valores no afecta recompensas ya otorgadas — cada una guarda su propio costo
          al momento de entregarse.
        </p>
        <CheckpointsForm initial={checkpointRows} available={available} />
      </div>

      {history.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2 className="mini-title">Temporadas anteriores</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Temporada</th>
                  <th>Cerró</th>
                  <th>Podio</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td>Temporada {h.seasonNumber}</td>
                    <td>{dateTime(h.closedAt)}</td>
                    <td>
                      {h.podium.length === 0
                        ? '—'
                        : h.podium
                            .map((p) => `${p.position}. ${p.displayName ?? 'Jugador'} (${diamonds(p.seasonalDiamonds)} 💎)`)
                            .join(' · ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
