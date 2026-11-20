import Link from 'next/link';
import { DrizzleGiveawayAdminStore } from '@levelup/db';
import { getDb } from '../../../lib/db';
import { requireSession } from '../../../lib/session';
import { dateTime } from '../../../lib/format';
import { publishGiveawayAction } from './actions';
import { NewGiveawayForm } from './new-giveaway-form';

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

export default async function SorteosPage() {
  await requireSession();
  const giveaways = await new DrizzleGiveawayAdminStore(getDb()).listForAdmin();

  return (
    <>
      <h1 style={{ marginBottom: 0 }}>Sorteos</h1>
      <p className="subtitle">
        Los jugadores gastan Golden Tickets — que ya ganan con cada recarga entregada — para
        participar. El sorteo del ganador siempre lo haces tú desde aquí; nunca es automático.
      </p>

      <NewGiveawayForm />

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Sorteo</th>
              <th>Premio</th>
              <th className="num">Costo</th>
              <th className="num">Entradas</th>
              <th>Cierra</th>
              <th>Estado</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {giveaways.length === 0 && (
              <tr>
                <td colSpan={7} style={{ color: 'var(--muted)' }}>
                  Todavía no hay sorteos.
                </td>
              </tr>
            )}
            {giveaways.map((g) => (
              <tr key={g.id}>
                <td>
                  <Link href={`/sorteos/${g.id}`}>{g.title}</Link>
                </td>
                <td>{g.prizeDescription}</td>
                <td className="num">{g.entryCostTickets} tickets</td>
                <td className="num">
                  {g.totalEntryCount} ({g.totalEntrants} jugador{g.totalEntrants === 1 ? '' : 'es'})
                </td>
                <td>{dateTime(g.closesAt)}</td>
                <td>
                  <span className={`badge ${STATUS_TONE[g.status]}`}>{STATUS_LABEL[g.status]}</span>
                </td>
                <td>
                  {g.status === 'draft' && (
                    <form action={publishGiveawayAction}>
                      <input type="hidden" name="id" value={g.id} />
                      <button className="btn sm" type="submit">
                        Publicar
                      </button>
                    </form>
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
