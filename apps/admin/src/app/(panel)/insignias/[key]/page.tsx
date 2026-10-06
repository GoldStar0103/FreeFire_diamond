import { notFound } from 'next/navigation';
import { getBadgeDefinition, listBadgeHolders } from '@levelup/db';
import { getDb } from '../../../../lib/db';
import { requireSession } from '../../../../lib/session';
import { dateTime } from '../../../../lib/format';
import { BadgeForm } from '../badge-form';
import { AwardForm } from './award-form';
import { revokeBadge, toggleObtainable } from '../actions';

export const dynamic = 'force-dynamic';

export default async function InsigniaDetailPage({ params }: { params: Promise<{ key: string }> }) {
  await requireSession();
  const { key } = await params;
  const db = getDb();

  const badge = await getBadgeDefinition(db, key);
  if (!badge) notFound();

  const holders = await listBadgeHolders(db, key);

  return (
    <>
      <h1>{badge.title}</h1>
      <p className="subtitle mono">{badge.badgeKey}</p>

      <div className="card">
        <BadgeForm initial={badge} locked />
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="row">
          <h2 className="mini-title" style={{ marginBottom: 0 }}>
            Disponibilidad
          </h2>
          <div className="spacer" />
          <form action={toggleObtainable}>
            <input type="hidden" name="badgeKey" value={badge.badgeKey} />
            <input type="hidden" name="obtainable" value={String(!badge.obtainable)} />
            <button className="btn sm" type="submit">
              {badge.obtainable ? 'Deshabilitar' : 'Habilitar'}
            </button>
          </form>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2 className="mini-title">Otorgar manualmente</h2>
        <AwardForm badgeKey={badge.badgeKey} seasonScoped={badge.seasonScoped} />
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2 className="mini-title">Poseedores ({holders.filter((h) => !h.revokedAt).length})</h2>
        {holders.length === 0 ? (
          <p className="hint">Nadie tiene esta insignia todavía.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ID Free Fire</th>
                  <th>Nombre</th>
                  <th>Temporada</th>
                  <th>Origen</th>
                  <th>Fecha</th>
                  <th>Estado</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {holders.map((h) => (
                  <tr key={h.ownershipId}>
                    <td className="mono">{h.playerId}</td>
                    <td>{h.displayName ?? '—'}</td>
                    <td>{h.seasonNumber ?? '—'}</td>
                    <td>{h.source === 'manual' ? 'Manual' : 'Automático'}</td>
                    <td>{dateTime(h.earnedAt)}</td>
                    <td>
                      {h.revokedAt ? <span className="badge muted">Revocada</span> : <span className="badge ok">Activa</span>}
                    </td>
                    <td>
                      {!h.revokedAt && (
                        <form action={revokeBadge}>
                          <input type="hidden" name="ownershipId" value={h.ownershipId} />
                          <input type="hidden" name="badgeKey" value={badge.badgeKey} />
                          <button className="btn sm danger" type="submit">
                            Revocar
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
