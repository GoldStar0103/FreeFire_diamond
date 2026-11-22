import { notFound } from 'next/navigation';
import { DrizzleGiveawayAdminStore } from '@levelup/db';
import { getDb } from '../../../../lib/db';
import { requireSession } from '../../../../lib/session';
import { dateTime, mxn } from '../../../../lib/format';
import { DrawWinnerForm } from './draw-winner-form';
import { CancelGiveawayForm } from './cancel-giveaway-form';
import { MarkDeliveredForm } from './mark-delivered-form';
import { SetPrizeValueForm } from './set-prize-value-form';

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<string, string> = {
  draft: 'Borrador',
  open: 'Abierto',
  closed_pending_draw: 'Cerrado — falta sortear',
  drawn: 'Sorteado',
  delivered: 'Entregado',
  cancelled: 'Cancelado',
};

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'muted'> = {
  draft: 'muted',
  open: 'ok',
  closed_pending_draw: 'warn',
  drawn: 'ok',
  delivered: 'ok',
  cancelled: 'bad',
};

const SCHEDULE_LABEL: Record<string, string> = {
  daily: 'Diario',
  weekly: 'Semanal',
  monthly: 'Mensual',
  flash: 'Flash',
};

const PRIZE_TYPE_LABEL: Record<string, string> = {
  manual: 'Manual (entrega a mano)',
  diamonds: 'Diamantes (entrega automática)',
};

const WINNER_DELIVERY_LABEL: Record<string, string> = {
  pending: 'Pendiente',
  delivered: 'Entregado',
  failed: 'Falló',
};

const WINNER_DELIVERY_TONE: Record<string, 'ok' | 'warn' | 'bad'> = {
  pending: 'warn',
  delivered: 'ok',
  failed: 'bad',
};

export default async function GiveawayDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;

  const store = new DrizzleGiveawayAdminStore(getDb());
  const [giveaway, entries, winners] = await Promise.all([
    store.getForAdmin(id),
    store.listEntries(id),
    store.listWinners(id),
  ]);
  if (!giveaway) notFound();

  return (
    <>
      <h1 style={{ marginBottom: 0 }}>{giveaway.title}</h1>
      <p className="subtitle">
        {SCHEDULE_LABEL[giveaway.scheduleType]} · Premio: {giveaway.prizeDescription} · Costo:{' '}
        {giveaway.entryCostTickets} tickets por entrada
      </p>

      <div className="card">
        <div className="row" style={{ gap: 24, flexWrap: 'wrap' }}>
          <div>
            <div className="hint">Estado</div>
            <span className={`badge ${STATUS_TONE[giveaway.status]}`}>{STATUS_LABEL[giveaway.status]}</span>
          </div>
          <div>
            <div className="hint">Abre</div>
            {dateTime(giveaway.opensAt)}
          </div>
          <div>
            <div className="hint">Cierra</div>
            {dateTime(giveaway.closesAt)}
          </div>
          <div>
            <div className="hint">Entradas totales</div>
            {giveaway.totalEntryCount} ({giveaway.totalEntrants} jugador{giveaway.totalEntrants === 1 ? '' : 'es'})
          </div>
          <div>
            <div className="hint">Mínimo para sortear</div>
            {giveaway.minEntries}
          </div>
          <div>
            <div className="hint">Máx. por jugador</div>
            {giveaway.maxEntriesPerPlayer ?? 'Sin límite'}
          </div>
          <div>
            <div className="hint">Máx. participantes</div>
            {giveaway.maxParticipants ?? 'Sin límite'}
          </div>
          <div>
            <div className="hint">Valor del premio (por ganador)</div>
            {giveaway.prizeValueCents != null ? mxn(giveaway.prizeValueCents) : 'Sin definir'}
          </div>
          <div>
            <div className="hint">Ganadores</div>
            {giveaway.winnerCount}
          </div>
          <div>
            <div className="hint">Tipo de premio</div>
            {PRIZE_TYPE_LABEL[giveaway.prizeType]}
            {giveaway.prizeType === 'diamonds' && giveaway.prizeDiamonds != null
              ? ` — ${giveaway.prizeDiamonds} 💎`
              : ''}
          </div>
        </div>
        <p style={{ marginTop: 12 }}>{giveaway.description}</p>
      </div>

      {giveaway.status !== 'delivered' && (
        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: 16 }}>Valor del premio (por ganador)</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            {giveaway.prizeType === 'diamonds'
              ? 'Hace falta antes de poder sortear — se congela por cada ganador y se registra como gasto en Contabilidad cuando se entrega el premio.'
              : 'Hace falta antes de poder sortear. Se registra como gasto en Contabilidad cuando marques a cada ganador como entregado.'}{' '}
            {(giveaway.status === 'draft' || giveaway.status === 'open') &&
              'Defínelo antes de que cierre y el ganador se sortea solo en cuanto cierre — sin tener que volver aquí.'}
          </p>
          <SetPrizeValueForm
            giveawayId={giveaway.id}
            currentValuePesos={giveaway.prizeValueCents != null ? (giveaway.prizeValueCents / 100).toFixed(2) : null}
          />
        </div>
      )}

      {giveaway.status === 'cancelled' && giveaway.cancelReason && (
        <div className="alert bad">Cancelado: {giveaway.cancelReason}</div>
      )}

      {giveaway.status === 'closed_pending_draw' && (
        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: 16 }}>Sortear {giveaway.winnerCount === 1 ? 'ganador' : 'ganadores'}</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            Esto ya cerró sin sortearse solo porque no tenía un valor de premio definido a tiempo —
            el sorteo se hace solo apenas cierra cuando ese valor ya está puesto.
          </p>
          <DrawWinnerForm giveawayId={giveaway.id} winnerCount={giveaway.winnerCount} />
        </div>
      )}

      {winners.length > 0 && (
        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: 16 }}>
            {winners.length === 1 ? 'Ganador' : 'Ganadores'} — sorteado {dateTime(giveaway.drawnAt)}
          </h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Jugador</th>
                  <th>ID de entrega</th>
                  <th className="num">Valor</th>
                  <th>Estado</th>
                  {giveaway.prizeType === 'manual' && <th />}
                </tr>
              </thead>
              <tbody>
                {winners.map((w) => (
                  <tr key={w.id}>
                    <td>{w.playerDisplayName ?? w.playerId}</td>
                    <td>{w.freeFireId}</td>
                    <td className="num">{mxn(w.costCentsSnapshot)}</td>
                    <td>
                      <span className={`badge ${WINNER_DELIVERY_TONE[w.deliveryStatus]}`}>
                        {WINNER_DELIVERY_LABEL[w.deliveryStatus]}
                      </span>
                    </td>
                    {giveaway.prizeType === 'manual' && (
                      <td>
                        {w.deliveryStatus === 'pending' && (
                          <MarkDeliveredForm giveawayId={giveaway.id} winnerId={w.id} />
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {giveaway.prizeType === 'diamonds' && (
            <p className="hint" style={{ marginBottom: 0 }}>
              Los diamantes se entregan solos — el worker crea y despacha el pedido de cada
              ganador automáticamente.
            </p>
          )}
        </div>
      )}

      {(giveaway.status === 'draft' || giveaway.status === 'open' || giveaway.status === 'closed_pending_draw') && (
        <div className="card">
          <CancelGiveawayForm giveawayId={giveaway.id} />
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Jugador</th>
              <th className="num">Entradas</th>
              <th className="num">Tickets gastados</th>
              <th>Primera entrada</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr>
                <td colSpan={4} style={{ color: 'var(--muted)' }}>
                  Todavía no hay participantes.
                </td>
              </tr>
            )}
            {entries.map((e) => (
              <tr key={e.playerProfileId}>
                <td>
                  {e.playerDisplayName ?? e.playerId} <span style={{ color: 'var(--muted)' }}>({e.playerId})</span>
                </td>
                <td className="num">{e.entryCount}</td>
                <td className="num">{e.ticketsSpent}</td>
                <td>{dateTime(e.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
