import { notFound } from 'next/navigation';
import { DrizzleGiveawayAdminStore } from '@levelup/db';
import { getDb } from '../../../../lib/db';
import { requireSession } from '../../../../lib/session';
import { dateTime } from '../../../../lib/format';
import { markDeliveredAction } from '../actions';
import { DrawWinnerForm } from './draw-winner-form';
import { CancelGiveawayForm } from './cancel-giveaway-form';

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

export default async function GiveawayDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;

  const store = new DrizzleGiveawayAdminStore(getDb());
  const [giveaway, entries] = await Promise.all([store.getForAdmin(id), store.listEntries(id)]);
  if (!giveaway) notFound();

  const winnerEntry = giveaway.winnerPlayerProfileId
    ? entries.find((e) => e.playerProfileId === giveaway.winnerPlayerProfileId)
    : undefined;

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
        </div>
        <p style={{ marginTop: 12 }}>{giveaway.description}</p>
      </div>

      {giveaway.status === 'cancelled' && giveaway.cancelReason && (
        <div className="alert bad">Cancelado: {giveaway.cancelReason}</div>
      )}

      {giveaway.status === 'closed_pending_draw' && (
        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: 16 }}>Sortear ganador</h2>
          <DrawWinnerForm giveawayId={giveaway.id} />
        </div>
      )}

      {(giveaway.status === 'drawn' || giveaway.status === 'delivered') && winnerEntry && (
        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: 16 }}>Ganador</h2>
          <p>
            <strong>{winnerEntry.playerDisplayName ?? winnerEntry.playerId}</strong> (ID {winnerEntry.playerId}) —
            sorteado {dateTime(giveaway.drawnAt)}
          </p>
          {giveaway.status === 'drawn' && (
            <form action={markDeliveredAction}>
              <input type="hidden" name="id" value={giveaway.id} />
              <button className="btn primary sm" type="submit">
                Marcar premio entregado
              </button>
            </form>
          )}
          {giveaway.status === 'delivered' && <span className="badge ok">Premio entregado</span>}
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
