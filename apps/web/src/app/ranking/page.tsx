import type { Metadata } from 'next';
import Link from 'next/link';
import { getPublicTop50, listSeasonHistory } from '@levelup/db';
import { getDb } from '../../lib/server.js';
import { avatarUrl } from '../../lib/assets.js';
import { dateLabel, diamonds, initials } from '../../lib/format.js';

export const metadata: Metadata = {
  title: 'Ranking',
  description: 'Los jugadores con más diamantes en su ID ligado esta temporada.',
  alternates: { canonical: '/ranking' },
};

export const dynamic = 'force-dynamic';

const MEDALS = ['🥇', '🥈', '🥉'];
const PAGE_SIZE = 10;

function daysRemaining(endsAt: Date): number {
  return Math.max(0, Math.ceil((endsAt.getTime() - Date.now()) / 86_400_000));
}

function Avatar({ url, name, size }: { url: string | null; name: string; size: number }) {
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" width={size} height={size} style={{ borderRadius: '50%', objectFit: 'cover' }} />
  ) : (
    <div className="avatar" aria-hidden="true" style={{ width: size, height: size, fontSize: size * 0.4 }}>
      {initials(name)}
    </div>
  );
}

export default async function RankingPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; pagina?: string }>;
}) {
  const params = await searchParams;
  const tab = params.tab === 'fama' ? 'fama' : 'top50';
  const db = getDb();

  const { season, rows } = await getPublicTop50(db);
  const days = season ? daysRemaining(season.endsAt) : null;

  return (
    <main className="page narrow">
      <h1 className="page-title">Ranking</h1>
      {season ? (
        <>
          <p className="hint">Temporada {season.seasonNumber}</p>
          {days !== null && <span className="season-pill">⏱ {days} día{days === 1 ? '' : 's'} restantes</span>}
        </>
      ) : (
        <p className="page-sub">Todavía no hay una temporada activa.</p>
      )}

      <div className="rk-tabs">
        <Link href="/ranking?tab=top50" className={`rk-tab${tab === 'top50' ? ' active' : ''}`}>
          Top 50
        </Link>
        <Link href="/ranking?tab=fama" className={`rk-tab${tab === 'fama' ? ' active' : ''}`}>
          Salón de la Fama
        </Link>
      </div>

      {tab === 'top50' ? (
        <Top50Tab rows={rows} pageParam={params.pagina} />
      ) : (
        <SalonDeLaFamaTab history={await listSeasonHistory(db)} />
      )}
    </main>
  );
}

function Top50Tab({
  rows,
  pageParam,
}: {
  rows: Awaited<ReturnType<typeof getPublicTop50>>['rows'];
  pageParam: string | undefined;
}) {
  if (rows.length === 0) {
    return (
      <div className="card" style={{ marginTop: 16 }}>
        <p className="hint">Todavía nadie ha recargado esta temporada.</p>
      </div>
    );
  }

  // Podium needs all 3 slots to look right centered on 1st place — with fewer
  // than 3 ranked players, skip straight to the plain list starting at rank 1
  // instead of rank 4, or an early leaderboard would render nothing at all.
  const hasPodium = rows.length >= 3;
  const podium = hasPodium ? rows.slice(0, 3) : [];
  const rest = rows.slice(hasPodium ? 3 : 0);

  const totalPages = Math.max(1, Math.ceil(rest.length / PAGE_SIZE));
  const page = Math.min(totalPages, Math.max(1, Number(pageParam) || 1));
  const pageRows = rest.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <>
      {/* Ranks 1-3 live in the podium, not in `rest`, so they never appear in
          `pageRows` either way — only show the podium itself on page 1,
          or paging through ranks 4+ redraws the same 3 cards every time. */}
      {hasPodium && page === 1 && (
        <div className="row" style={{ marginTop: 16, marginBottom: 16, alignItems: 'stretch', gap: 8 }}>
          {[1, 0, 2].map((i) => {
            const player = podium[i]!;
            const name = player.displayName ?? 'Jugador';
            return (
              <Link
                key={player.playerProfileId}
                href={`/jugador/${player.playerProfileId}`}
                className={`card rk-podium-card rk-podium-${i + 1}`}
                style={{ flex: 1, textAlign: 'center', order: i === 0 ? 2 : i === 1 ? 1 : 3 }}
              >
                <div style={{ fontSize: 28 }}>{MEDALS[player.rank - 1]}</div>
                <div style={{ margin: '4px auto', width: 'fit-content' }}>
                  <Avatar url={avatarUrl(player.avatarAssetUrl)} name={name} size={48} />
                </div>
                <div style={{ fontWeight: 700 }}>{name}</div>
                <div className="hint">{diamonds(player.seasonalDiamonds)} 💎</div>
              </Link>
            );
          })}
        </div>
      )}

      {pageRows.map((player) => {
        const name = player.displayName ?? 'Jugador';
        return (
          <Link
            key={player.playerProfileId}
            href={`/jugador/${player.playerProfileId}`}
            className="card row"
            style={{ marginBottom: 6 }}
          >
            <span className="mono" style={{ width: 28 }}>
              #{player.rank}
            </span>
            <Avatar url={avatarUrl(player.avatarAssetUrl)} name={name} size={32} />
            <span style={{ fontWeight: 600 }}>{name}</span>
            <div className="spacer" />
            <span className="hint">{diamonds(player.seasonalDiamonds)} 💎</span>
          </Link>
        );
      })}

      {totalPages > 1 && (
        <div className="rk-pagination">
          <Link
            href={`/ranking?tab=top50&pagina=${Math.max(1, page - 1)}`}
            className={`btn sm${page === 1 ? ' disabled' : ''}`}
            aria-disabled={page === 1}
          >
            ‹
          </Link>
          {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
            <Link
              key={p}
              href={`/ranking?tab=top50&pagina=${p}`}
              className={`btn sm${p === page ? ' primary' : ''}`}
            >
              {p}
            </Link>
          ))}
          <Link
            href={`/ranking?tab=top50&pagina=${Math.min(totalPages, page + 1)}`}
            className={`btn sm${page === totalPages ? ' disabled' : ''}`}
            aria-disabled={page === totalPages}
          >
            ›
          </Link>
        </div>
      )}
    </>
  );
}

function SalonDeLaFamaTab({ history }: { history: Awaited<ReturnType<typeof listSeasonHistory>> }) {
  if (history.length === 0) {
    return (
      <div className="card" style={{ marginTop: 16 }}>
        <p className="hint">
          Todavía no se ha cerrado ninguna temporada. Cuando esta temporada termine, su podio queda
          aquí para siempre.
        </p>
      </div>
    );
  }

  return (
    <>
      {history.map((season) => (
        <div key={season.id} className="card rk-fama-season" style={{ marginTop: 16 }}>
          <div className="row" style={{ alignItems: 'baseline' }}>
            <h2 className="mini-title" style={{ margin: 0 }}>
              Temporada {season.seasonNumber}
            </h2>
            <div className="spacer" />
            {season.closedAt && <span className="hint">Cerró el {dateLabel(season.closedAt)}</span>}
          </div>

          {season.podium.length === 0 ? (
            <p className="hint" style={{ marginTop: 8 }}>Esta temporada cerró sin un podio registrado.</p>
          ) : (
            <div className="row" style={{ marginTop: 12, gap: 8, alignItems: 'stretch' }}>
              {season.podium.map((p) => {
                const name = p.displayName ?? 'Jugador';
                return (
                  <Link
                    key={p.position}
                    href={`/jugador/${p.playerProfileId}`}
                    className={`card rk-podium-card rk-podium-${p.position}`}
                    style={{ flex: 1, textAlign: 'center' }}
                  >
                    <div style={{ fontSize: 24 }}>{MEDALS[p.position - 1] ?? `#${p.position}`}</div>
                    <div style={{ margin: '4px auto', width: 'fit-content' }}>
                      <Avatar url={avatarUrl(p.avatarAssetUrlSnapshot)} name={name} size={40} />
                    </div>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{name}</div>
                    <div className="hint">{diamonds(p.seasonalDiamonds)} 💎</div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </>
  );
}
