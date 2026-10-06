import type { Metadata } from 'next';
import Link from 'next/link';
import { getPublicTop50 } from '@levelup/db';
import { getDb } from '../../lib/server.js';
import { avatarUrl } from '../../lib/assets.js';
import { diamonds, initials } from '../../lib/format.js';

export const metadata: Metadata = {
  title: 'Ranking',
  description: 'Los jugadores que más han recargado esta temporada.',
  alternates: { canonical: '/ranking' },
};

export const dynamic = 'force-dynamic';

const MEDALS = ['🥇', '🥈', '🥉'];

export default async function RankingPage() {
  const top = await getPublicTop50(getDb());

  return (
    <main className="page narrow">
      <h1 className="page-title">Ranking de la temporada</h1>
      <p className="page-sub">Los 50 jugadores con más diamantes recargados esta temporada.</p>

      {top.length === 0 ? (
        <div className="card">
          <p className="hint">Todavía no hay una temporada activa, o nadie ha recargado todavía.</p>
        </div>
      ) : (
        <>
          {top.length >= 3 && (
            <div className="row" style={{ marginBottom: 16, alignItems: 'stretch', gap: 8 }}>
              {[1, 0, 2].map((i) => {
                const player = top[i]!;
                const avatar = avatarUrl(player.avatarAssetUrl);
                const name = player.displayName ?? 'Jugador';
                return (
                  <Link
                    key={player.playerProfileId}
                    href={`/jugador/${player.playerProfileId}`}
                    className="card"
                    style={{ flex: 1, textAlign: 'center', textDecoration: 'none', color: 'inherit', order: i === 0 ? 2 : i === 1 ? 1 : 3 }}
                  >
                    <div style={{ fontSize: 28 }}>{MEDALS[player.rank - 1]}</div>
                    {avatar ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={avatar} alt="" width={48} height={48} style={{ borderRadius: '50%', objectFit: 'cover', margin: '4px auto' }} />
                    ) : (
                      <div className="avatar" aria-hidden="true" style={{ margin: '4px auto' }}>
                        {initials(name)}
                      </div>
                    )}
                    <div style={{ fontWeight: 700 }}>{name}</div>
                    <div className="hint">{diamonds(player.seasonalDiamonds)} 💎</div>
                  </Link>
                );
              })}
            </div>
          )}

          {/* Fewer than 3 ranked players: skip the 3-up podium layout (it needs
              all three slots to look right centered on 1st place) and fall
              through to the plain list below, starting from rank 1 instead
              of rank 4 — otherwise an early or solo leaderboard would render
              nothing at all. */}
          {top.slice(top.length >= 3 ? 3 : 0).map((player) => {
            const avatar = avatarUrl(player.avatarAssetUrl);
            const name = player.displayName ?? 'Jugador';
            return (
              <Link
                key={player.playerProfileId}
                href={`/jugador/${player.playerProfileId}`}
                className="card row"
                style={{ marginBottom: 6, textDecoration: 'none', color: 'inherit' }}
              >
                <span className="mono" style={{ width: 28 }}>
                  #{player.rank}
                </span>
                {avatar ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={avatar} alt="" width={32} height={32} style={{ borderRadius: '50%', objectFit: 'cover' }} />
                ) : (
                  <div className="avatar" aria-hidden="true" style={{ width: 32, height: 32, fontSize: 12 }}>
                    {initials(name)}
                  </div>
                )}
                <span style={{ fontWeight: 600 }}>{name}</span>
                <div className="spacer" />
                <span className="hint">{diamonds(player.seasonalDiamonds)} 💎</span>
              </Link>
            );
          })}
        </>
      )}
    </main>
  );
}
