import Link from 'next/link';
import { getCurrentSeason, listAdminCustomers } from '@levelup/db';
import { getDb } from '../../../lib/db';
import { requireSession } from '../../../lib/session';
import { diamonds } from '../../../lib/format';

export const dynamic = 'force-dynamic';

export default async function ClientesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; checkpoint?: string }>;
}) {
  await requireSession();
  const params = await searchParams;
  const db = getDb();

  const parsed = params.checkpoint ? Number(params.checkpoint) : NaN;
  const checkpointLp = Number.isFinite(parsed) ? parsed : undefined;

  // Built key by key: `exactOptionalPropertyTypes` refuses an explicit
  // `undefined` for an optional property.
  const query: Parameters<typeof listAdminCustomers>[1] = {};
  if (params.q) query.search = params.q;
  if (checkpointLp !== undefined) query.checkpointLp = checkpointLp;

  const [season, rows] = await Promise.all([getCurrentSeason(db), listAdminCustomers(db, query)]);

  return (
    <>
      <h1>Clientes</h1>
      <p className="subtitle">
        Cuentas Mi LevelUp con su avance en {season ? `la Temporada ${season.seasonNumber}` : 'la temporada'}.
        Abre una para ver su economía completa.
      </p>

      {checkpointLp !== undefined && (
        <div className="alert warn">
          Mostrando solo quienes llegaron al checkpoint de {checkpointLp.toLocaleString('es-MX')} LP.{' '}
          <Link href="/clientes" style={{ textDecoration: 'underline' }}>
            Ver todos
          </Link>
        </div>
      )}

      <form className="row" style={{ marginBottom: 12 }}>
        {checkpointLp !== undefined && (
          <input type="hidden" name="checkpoint" value={String(checkpointLp)} />
        )}
        <label className="field" style={{ margin: 0, flex: 1 }}>
          <span>Buscar</span>
          <input name="q" defaultValue={params.q ?? ''} placeholder="Nombre, ID de Free Fire o correo" />
        </label>
        <button className="btn sm primary" type="submit" style={{ alignSelf: 'flex-end' }}>
          Buscar
        </button>
      </form>

      {rows.length === 0 ? (
        <div className="card empty">
          {params.q || checkpointLp !== undefined
            ? 'Ningún cliente coincide.'
            : 'Todavía no hay cuentas Mi LevelUp.'}
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Jugador</th>
                <th>ID ligado</th>
                <th className="num">LP</th>
                <th className="num">💎 temporada</th>
                <th className="num">💎 histórico</th>
                <th className="num">Recargas</th>
                <th>Bóveda</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.playerProfileId}>
                  <td className="num">{row.rank ?? '—'}</td>
                  <td>
                    <Link href={`/clientes/${row.playerProfileId}`} style={{ textDecoration: 'underline' }}>
                      {row.displayName ?? 'Jugador'}
                    </Link>
                  </td>
                  <td className="mono">{row.playerId}</td>
                  <td className="num">{row.lp.toLocaleString('es-MX')}</td>
                  <td className="num">{diamonds(row.seasonalDiamonds)}</td>
                  <td className="num">{diamonds(row.lifetimeDiamondsPurchased)}</td>
                  <td className="num">{row.lifetimeRechargeCount}</td>
                  <td>
                    {row.vaultActive ? (
                      <span className="badge ok">Abierta</span>
                    ) : (
                      <span className="badge muted">—</span>
                    )}
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
