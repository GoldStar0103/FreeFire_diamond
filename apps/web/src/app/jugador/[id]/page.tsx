import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getPublicProfile } from '@levelup/db';
import { getDb } from '../../../lib/server.js';
import { avatarUrl } from '../../../lib/assets.js';
import { diamonds, initials } from '../../../lib/format.js';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const profile = await getPublicProfile(getDb(), id);
  return { title: profile?.displayName ?? 'Jugador' };
}

export default async function PublicProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await getPublicProfile(getDb(), id);
  if (!profile) notFound();

  const avatar = avatarUrl(profile.avatarAssetUrl);
  const name = profile.displayName ?? 'Jugador';

  return (
    <main className="page narrow">
      <div className="row" style={{ alignItems: 'center', gap: 12 }}>
        {avatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatar} alt="" width={64} height={64} style={{ borderRadius: '50%', objectFit: 'cover' }} />
        ) : (
          <div className="avatar" aria-hidden="true" style={{ width: 64, height: 64, fontSize: 22 }}>
            {initials(name)}
          </div>
        )}
        <div>
          <h1 className="page-title" style={{ marginBottom: 0 }}>
            {name}
          </h1>
          <p className="hint">LevelUp desde {profile.memberSinceYear}</p>
        </div>
      </div>

      {profile.featuredBadges.length > 0 && (
        <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
          {profile.featuredBadges.map((b) => (
            <span key={b.ownershipId} className="badge-pill" title={b.title}>
              🏅 {b.title}
            </span>
          ))}
        </div>
      )}

      <div className="stats-row" style={{ marginTop: 16 }}>
        {profile.currentRank && (
          <div className="card counter">
            <div className="counter-value">#{profile.currentRank}</div>
            <div className="counter-label">en el ranking actual</div>
          </div>
        )}
        <div className="card counter">
          <div className="counter-value">{diamonds(profile.currentSeasonalDiamonds)}</div>
          <div className="counter-label">💎 esta temporada</div>
        </div>
        {profile.highestHistoricalRank && (
          <div className="card counter">
            <div className="counter-value">#{profile.highestHistoricalRank}</div>
            <div className="counter-label">mejor posición histórica</div>
          </div>
        )}
        <div className="card counter">
          <div className="counter-value">{profile.levelPassesCompleted}</div>
          <div className="counter-label">Level Pass completados</div>
        </div>
      </div>
    </main>
  );
}
