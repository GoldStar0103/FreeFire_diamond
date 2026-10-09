import type { SeasonFunnel as SeasonFunnelData } from '@levelup/db';
import { diamonds, mxn } from '../../../lib/format';

const pct = (value: number | null) => (value === null ? '—' : `${value.toFixed(1)}%`);

/**
 * One season's progression funnel and Pass economics.
 *
 * The bar is drawn from `pctOfParticipants` rather than from the raw count so
 * every season renders on the same scale and two seasons can be compared by
 * eye — which is the whole point of keeping the closed ones on screen.
 */
export function SeasonFunnel({ funnel }: { funnel: SeasonFunnelData }) {
  const hasActivity = funnel.participants > 0;

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2 className="mini-title">
        Temporada {funnel.seasonNumber} — comportamiento
        {funnel.status === 'closed' && <span className="badge muted" style={{ marginLeft: 8 }}>cerrada</span>}
      </h2>

      {!hasActivity ? (
        <p className="subtitle" style={{ marginBottom: 0 }}>
          Todavía nadie ha ganado Level Points en esta temporada.
        </p>
      ) : (
        <>
          <div className="stat-grid">
            <div className="card">
              <div className="stat-label">Participantes</div>
              <div className="stat-value">{funnel.participants}</div>
            </div>
            <div className="card">
              <div className="stat-label">Bóveda desbloqueada</div>
              <div className="stat-value">{funnel.vaultUnlocked}</div>
            </div>
            <div className="card">
              <div className="stat-label">LP otorgados</div>
              <div className="stat-value">{funnel.totalLpAwarded.toLocaleString('es-MX')}</div>
            </div>
          </div>

          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr>
                  <th>Checkpoint</th>
                  <th>Recompensa</th>
                  <th className="num">Llegaron</th>
                  <th className="num">% del total</th>
                  <th className="num">% del paso anterior</th>
                </tr>
              </thead>
              <tbody>
                {funnel.stages.map((stage) => (
                  <tr key={stage.checkpointLp}>
                    <td>{stage.checkpointLp.toLocaleString('es-MX')} LP</td>
                    <td>{diamonds(stage.rewardDiamonds)} 💎</td>
                    <td className="num">{stage.reached}</td>
                    <td className="num">{pct(stage.pctOfParticipants)}</td>
                    <td className="num">{pct(stage.pctOfPrevious)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className="mini-title" style={{ marginTop: 16 }}>Economía del Pass</h3>
          <p className="subtitle">
            El Pass se diseñó para que las recompensas cuesten cerca del 20% de la ganancia que
            generan sus participantes. Esto es lo que está pasando de verdad, no el objetivo.
          </p>
          <div className="stat-grid">
            <div className="card">
              <div className="stat-label">Ganancia de participantes</div>
              <div className="stat-value">{mxn(funnel.profitFromParticipantsCents)}</div>
            </div>
            <div className="card">
              <div className="stat-label">Costo de recompensas</div>
              <div className="stat-value">{mxn(funnel.rewardCostCents)}</div>
            </div>
            <div className="card">
              <div className="stat-label">Ganancia retenida</div>
              <div className={`stat-value${funnel.retainedProfitCents < 0 ? ' bad' : ' ok'}`}>
                {mxn(funnel.retainedProfitCents)}
              </div>
            </div>
            <div className="card">
              <div className="stat-label">Costo real de recompensas</div>
              <div className="stat-value">{pct(funnel.realizedRewardCostRatioPct)}</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
