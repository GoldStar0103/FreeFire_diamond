import type { Metadata } from 'next';
import Link from 'next/link';
import { getMyLevelUpOverview, getMyProfile, listMyOrders } from '@levelup/db';
import { getCustomerSession } from '../../lib/customer-session.js';
import { getDb } from '../../lib/server.js';
import { avatarUrl } from '../../lib/assets.js';
import { diamonds, initials, mxn } from '../../lib/format.js';
import { CuentaForm } from './cuenta-form';
import { logout } from './profile-actions';

export const metadata: Metadata = {
  title: 'Mi LevelUp',
  description: 'Tu progreso, tus insignias y tus recompensas.',
  alternates: { canonical: '/cuenta' },
};

export const dynamic = 'force-dynamic';

const ORDER_STATUS_LABELS: Record<string, string> = {
  pending_payment: 'Esperando pago',
  payment_confirmed: 'Pago confirmado',
  processing: 'Procesando',
  partially_delivered: 'Entrega parcial',
  completed: 'Completado',
  payment_expired: 'Pago vencido',
  needs_review: 'En revisión',
  refund_required: 'En revisión',
  cancelled: 'Cancelado',
};

function daysRemaining(endsAt: Date): number {
  return Math.max(0, Math.ceil((endsAt.getTime() - Date.now()) / 86_400_000));
}

export default async function CuentaPage() {
  const session = await getCustomerSession();

  if (!session) {
    return (
      <main className="page narrow">
        <h1 className="page-title">Mi LevelUp</h1>
        <p className="page-sub">Inicia sesión con tu WhatsApp para ver tu progreso, rachas y recompensas.</p>
        <CuentaForm />
      </main>
    );
  }

  const db = getDb();
  const [profile, overview, orders] = await Promise.all([
    getMyProfile(db, session.playerProfileId),
    getMyLevelUpOverview(db, session.playerProfileId),
    listMyOrders(db, session.playerId, 10),
  ]);

  if (!profile) {
    // The session cookie outlived the account somehow (should not happen in
    // practice) — safest is to drop back to the login state, not crash.
    return (
      <main className="page narrow">
        <h1 className="page-title">Mi LevelUp</h1>
        <p className="page-sub">Tu sesión ya no es válida. Inicia sesión de nuevo.</p>
        <CuentaForm />
      </main>
    );
  }

  const avatar = avatarUrl(profile.avatarAssetUrl);
  const name = profile.displayName ?? `Jugador ${profile.playerId}`;
  const nextCheckpoint = overview.checkpoints.find((c) => !c.reached);

  return (
    <main className="page narrow">
      <div className="row" style={{ alignItems: 'center', gap: 12 }}>
        {avatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatar} alt="" width={56} height={56} style={{ borderRadius: '50%', objectFit: 'cover' }} />
        ) : (
          <div className="avatar" aria-hidden="true" style={{ width: 56, height: 56, fontSize: 20 }}>
            {initials(name)}
          </div>
        )}
        <div>
          <h1 className="page-title" style={{ marginBottom: 0 }}>
            {name}
          </h1>
          {overview.season && overview.rank && <p className="hint">Posición #{overview.rank} esta temporada</p>}
        </div>
        <div className="spacer" />
        <Link href="/cuenta/perfil" className="btn ghost">
          Editar perfil
        </Link>
      </div>

      <div className="stats-row" style={{ marginTop: 16 }}>
        <div className="card counter">
          <div className="counter-value">{diamonds(profile.lifetimeDiamondsPurchased)}</div>
          <div className="counter-label">diamantes históricos</div>
        </div>
        <div className="card counter">
          <div className="counter-value">{profile.lifetimeRechargeCount}</div>
          <div className="counter-label">recargas</div>
        </div>
        <div className="card counter">
          <div className="counter-value">{overview.lp}</div>
          <div className="counter-label">LP esta temporada</div>
        </div>
      </div>

      {overview.featuredBadges.length > 0 && (
        <div className="row" style={{ marginTop: 16, gap: 8, flexWrap: 'wrap' }}>
          {overview.featuredBadges.map((b) => (
            <span key={b.ownershipId} className="badge-pill" title={b.title}>
              🏅 {b.title}
            </span>
          ))}
          <Link href="/cuenta/insignias" className="hint">
            Ver todas →
          </Link>
        </div>
      )}
      {overview.featuredBadges.length === 0 && (
        <p className="hint" style={{ marginTop: 12 }}>
          <Link href="/cuenta/insignias">Todavía no has elegido insignias destacadas →</Link>
        </p>
      )}

      <div className="trust-grid" style={{ marginTop: 16 }}>
        <div className="card">
          <h2 className="mini-title">Level Pass</h2>
          {overview.season ? (
            nextCheckpoint ? (
              <>
                <p className="hint">
                  {overview.lp} / {nextCheckpoint.lp} LP para tu próxima recompensa
                </p>
                <div className="progress-track">
                  <div
                    className="progress-fill"
                    style={{ width: `${Math.min(100, (overview.lp / nextCheckpoint.lp) * 100)}%` }}
                  />
                </div>
                <p className="hint" style={{ marginTop: 6 }}>
                  Siguiente: {diamonds(nextCheckpoint.rewardDiamonds)} 💎
                </p>
              </>
            ) : (
              <p className="hint">¡Completaste el Level Pass de esta temporada! 🎉</p>
            )
          ) : (
            <p className="hint">Todavía no hay una temporada activa.</p>
          )}
        </div>

        <div className="card">
          <h2 className="mini-title">Temporada</h2>
          {overview.season ? (
            <>
              <p className="hint">{diamonds(overview.seasonalDiamonds)} 💎 esta temporada</p>
              <p className="hint">{daysRemaining(overview.season.endsAt)} días restantes</p>
              <Link href="/ranking" className="hint">
                Ver ranking →
              </Link>
            </>
          ) : (
            <p className="hint">Sin temporada activa.</p>
          )}
        </div>

        <div className="card">
          <h2 className="mini-title">La Bóveda</h2>
          {overview.vault.unlocked ? (
            <>
              <p className="hint">Desbloqueada — {overview.vault.offers.length} ofertas disponibles</p>
              {overview.vault.expiresAt && <p className="hint">Cierra en {daysRemaining(overview.vault.expiresAt)} días</p>}
              {overview.vault.offers.map((o) => (
                <div key={o.vaultOfferId} className="row" style={{ marginTop: 6, alignItems: 'center' }}>
                  <span className="hint">
                    {o.comboName}: <s>{mxn(o.publicPriceMxnCents)}</s> → <strong>{mxn(o.vaultPriceMxnCents)}</strong>
                  </span>
                  <div className="spacer" />
                  <Link
                    href={`/comprar/${o.comboKey}?oferta=${o.vaultOfferId}`}
                    className="btn sm primary"
                  >
                    Comprar
                  </Link>
                </div>
              ))}
            </>
          ) : (
            <p className="hint">Completa el Level Pass para desbloquear la Bóveda.</p>
          )}
        </div>
      </div>

      {orders.length > 0 && (
        <section style={{ marginTop: 16 }}>
          <h2 className="section-title">Tus pedidos recientes</h2>
          {orders.map((o) => (
            <div key={o.orderNumber} className="card" style={{ marginBottom: 8 }}>
              <div className="row">
                <span className="mono">{o.orderNumber}</span>
                <div className="spacer" />
                <span>{mxn(o.priceMxnCents)}</span>
              </div>
              <div className="row" style={{ marginTop: 4 }}>
                <span className="hint">{o.comboName}</span>
                <div className="spacer" />
                <span className="hint">{ORDER_STATUS_LABELS[o.status] ?? o.status}</span>
                {o.lpEarned !== null && <span className="hint">+{o.lpEarned} LP</span>}
              </div>
            </div>
          ))}
        </section>
      )}

      <form action={logout} style={{ marginTop: 20 }}>
        <button className="btn ghost" type="submit">
          Cerrar sesión
        </button>
      </form>
    </main>
  );
}
