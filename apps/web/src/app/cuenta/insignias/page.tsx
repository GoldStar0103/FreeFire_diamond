import type { Metadata } from 'next';
import { listMyBadges } from '@levelup/db';
import { requireCustomerSession } from '../../../lib/customer-session.js';
import { getDb } from '../../../lib/server.js';
import { saveFeaturedBadges } from '../profile-actions';
import { dateLabel } from '../../../lib/format.js';

export const metadata: Metadata = {
  title: 'Mis insignias',
  alternates: { canonical: '/cuenta/insignias' },
};

export const dynamic = 'force-dynamic';

const CATEGORY_LABELS: Record<string, string> = {
  special: 'Especiales',
  ranking: 'Ranking',
  level_pass: 'Level Pass',
  event: 'Eventos',
};

const CATEGORY_ORDER = ['special', 'ranking', 'level_pass', 'event'];

export default async function InsigniasPage() {
  const session = await requireCustomerSession();
  const badges = await listMyBadges(getDb(), session.playerProfileId);

  const byCategory = new Map<string, typeof badges>();
  for (const b of badges) {
    const list = byCategory.get(b.category) ?? [];
    list.push(b);
    byCategory.set(b.category, list);
  }

  return (
    <main className="page narrow">
      <h1 className="page-title">Mis insignias</h1>
      <p className="page-sub">Elige hasta 4 para mostrar en tu perfil — marca las casillas y guarda.</p>

      {badges.length === 0 ? (
        <div className="card">
          <p className="hint">Todavía no tienes ninguna insignia. Sigue comprando y compitiendo para ganar la primera.</p>
        </div>
      ) : (
        <form action={saveFeaturedBadges}>
          {CATEGORY_ORDER.filter((cat) => byCategory.has(cat)).map((category) => (
            <div key={category} className="card" style={{ marginBottom: 12 }}>
              <h2 className="mini-title">{CATEGORY_LABELS[category] ?? category}</h2>
              {byCategory.get(category)!.map((b) => (
                <label key={b.ownershipId} className="row" style={{ alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <input type="checkbox" name="ownershipId" value={b.ownershipId} defaultChecked={b.featured} />
                  <span className={`badge-pill${b.featured ? ' selected' : ''}`}>🏅 {b.title}</span>
                  <span className="hint">
                    {b.seasonNumber ? `Temporada ${b.seasonNumber} · ` : ''}
                    {dateLabel(b.earnedAt)}
                  </span>
                  {b.description && <span className="hint">{b.description}</span>}
                </label>
              ))}
            </div>
          ))}

          <button className="btn primary wide" type="submit">
            Guardar insignias destacadas
          </button>
        </form>
      )}
    </main>
  );
}
