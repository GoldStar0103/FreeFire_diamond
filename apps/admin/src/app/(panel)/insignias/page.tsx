import Link from 'next/link';
import { listBadgeDefinitions } from '@levelup/db';
import { getDb } from '../../../lib/db';
import { requireSession } from '../../../lib/session';

export const dynamic = 'force-dynamic';

const CATEGORY_LABELS: Record<string, string> = {
  ranking: 'Ranking',
  level_pass: 'Level Pass',
  special: 'Especial',
  event: 'Evento',
};

export default async function InsigniasPage() {
  await requireSession();
  const badges = await listBadgeDefinitions(getDb());

  return (
    <>
      <div className="row">
        <h1 style={{ marginBottom: 0 }}>Insignias</h1>
        <div className="spacer" />
        <Link className="btn primary" href="/insignias/nueva">
          Nueva insignia
        </Link>
      </div>
      <p className="subtitle">
        Insignias de ranking y de Level Pass se otorgan solas. Las demás se otorgan a mano desde la
        página de cada insignia.
      </p>

      {badges.length === 0 ? (
        <div className="alert warn">
          Todavía no hay ninguna insignia definida — nada se otorgará hasta que crees al menos una
          (por ejemplo "season_champion", "top_3", "top_10", "top_50", "level_pass_completed", "founder").
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Clave</th>
                <th>Título</th>
                <th>Categoría</th>
                <th>Por temporada</th>
                <th className="num">Poseedores</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {badges.map((b) => (
                <tr key={b.id}>
                  <td className="mono">
                    <Link href={`/insignias/${b.badgeKey}`} style={{ color: 'var(--accent)' }}>
                      {b.badgeKey}
                    </Link>
                  </td>
                  <td>{b.title}</td>
                  <td>{CATEGORY_LABELS[b.category] ?? b.category}</td>
                  <td>{b.seasonScoped ? 'Sí' : 'No'}</td>
                  <td className="num">{b.holderCount}</td>
                  <td>
                    <span className={`badge ${b.obtainable ? 'ok' : 'muted'}`}>
                      {b.obtainable ? 'Disponible' : 'Deshabilitada'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
