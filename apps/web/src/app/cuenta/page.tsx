import type { Metadata } from 'next';
import Link from 'next/link';
import { getMyLevelUpOverview, getMyProfile, listMyOrders } from '@levelup/db';
import { getCustomerSession } from '../../lib/customer-session.js';
import { getDb } from '../../lib/server.js';
import { avatarUrl } from '../../lib/assets.js';
import { diamonds, initials, mxn } from '../../lib/format.js';
import mascot from '../../assets/mascot.webp';
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
  refunded: 'Reembolsado',
};

function daysRemaining(endsAt: Date): number {
  return Math.max(0, Math.ceil((endsAt.getTime() - Date.now()) / 86_400_000));
}

export default async function CuentaPage() {
  const session = await getCustomerSession();

  if (!session) {
    return (
      <main className="page narrow">
        <section className="hx-hero" style={{ minHeight: 280, marginLeft: 0, marginRight: 0 }}>
          <div className="hx-hero-copy hx-rise">
            <p className="hx-kicker">Mi cuenta</p>
            <h1>
              Tu temporada, <span className="grad">en un solo lugar</span>
            </h1>
            <p className="hx-hero-lead">
              Entra con tu correo — sin contraseña. Un ID para el ranking. Cualquier recarga con
              tu cuenta suma al Level Pass y La Bóveda.
            </p>
          </div>
          <div className="hx-mascot hx-rise-2" aria-hidden="true">
            <div className="hx-mascot-glow" />
            <img src={mascot.src} alt="" decoding="async" />
          </div>
        </section>
        <div className="hx-rise-3">
          <CuentaForm />
        </div>
      </main>
    );
  }

  const db = getDb();
  const [profile, overview, orders] = await Promise.all([
    getMyProfile(db, session.playerProfileId),
    getMyLevelUpOverview(db, session.playerProfileId),
    listMyOrders(db, session.playerId, 10, session.playerProfileId),
  ]);

  if (!profile) {
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
  const seasonDays = overview.season ? daysRemaining(overview.season.endsAt) : null;
  const prevLp = (() => {
    if (!nextCheckpoint) return 0;
    const idx = overview.checkpoints.findIndex((c) => c.lp === nextCheckpoint.lp);
    return idx > 0 ? overview.checkpoints[idx - 1]!.lp : 0;
  })();
  const span = nextCheckpoint ? nextCheckpoint.lp - prevLp : 1;
  const pct = nextCheckpoint ? Math.max(0, Math.min(100, ((overview.lp - prevLp) / span) * 100)) : 100;

  return (
    <main className="page narrow">
      <div className="card hx-pass hx-rise">
        <div className="hx-profile-hero">
          <div className="me-avatar-ring">
            {avatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={avatar} alt="" width={84} height={84} style={{ borderRadius: '50%', objectFit: 'cover', display: 'block' }} />
            ) : (
              <div className="avatar" aria-hidden="true" style={{ width: 84, height: 84, fontSize: 28 }}>
                {initials(name)}
              </div>
            )}
          </div>
          <div>
            <p className="me-kicker grad">¡Hola de nuevo!</p>
            <h1 className="page-title" style={{ marginBottom: 4 }}>
              {name}
            </h1>
            <p className="hint mono" style={{ margin: 0 }}>
              ID de temporada {profile.playerId}
            </p>
            <div className="me-pills">
              {overview.season && overview.rank && <span className="season-pill">Posición #{overview.rank}</span>}
              {seasonDays !== null && (
                <span className="season-pill">
                  {seasonDays} día{seasonDays === 1 ? '' : 's'}
                </span>
              )}
              <span className={`season-pill${overview.vault.unlocked ? ' unlocked-gold' : ' locked'}`}>
                {overview.vault.unlocked ? 'Bóveda abierta' : 'Bóveda cerrada'}
              </span>
            </div>
          </div>
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <Link href="/cuenta/perfil" className="btn ghost sm">
            Editar perfil
          </Link>
          <p className="hint" style={{ margin: 0 }}>
            Recargas a otros IDs también suman LP y La Bóveda.
          </p>
        </div>
      </div>

      <div className="card hx-statbar hx-rise-2">
        <div className="counter">
          <div className="counter-value">{diamonds(profile.lifetimeDiamondsPurchased)}</div>
          <div className="counter-label">diamantes históricos</div>
        </div>
        <div className="counter">
          <div className="counter-value">{profile.lifetimeRechargeCount}</div>
          <div className="counter-label">recargas</div>
        </div>
        <div className="counter">
          <div className="counter-value">{overview.lp}</div>
          <div className="counter-label">LP esta temporada</div>
        </div>
      </div>

      {overview.featuredBadges.length > 0 && (
        <div className="row" style={{ marginTop: 4, gap: 8, flexWrap: 'wrap' }}>
          {overview.featuredBadges.map((b) => (
            <span key={b.ownershipId} className="badge-pill" title={b.title}>
              {b.title}
            </span>
          ))}
          <Link href="/cuenta/insignias" className="hint">
            Ver todas →
          </Link>
        </div>
      )}
      {overview.featuredBadges.length === 0 && (
        <p className="hint">
          <Link href="/cuenta/insignias">Elige tus insignias destacadas →</Link>
        </p>
      )}

      <Link href="/cuenta/level-pass" className="card hx-pass hx-rise-3" style={{ display: 'block' }}>
        <div className="hx-pass-head">
          <div>
            <h2 className="mini-title" style={{ margin: 0 }}>
              Level Pass
            </h2>
            {overview.season ? (
              <p className="hint" style={{ marginTop: 4 }}>
                {nextCheckpoint
                  ? `${overview.lp} / ${nextCheckpoint.lp} LP · siguiente ${diamonds(nextCheckpoint.rewardDiamonds)} 💎`
                  : 'Pass completado'}
              </p>
            ) : (
              <p className="hint">Todavía no hay una temporada activa.</p>
            )}
          </div>
          <span className="hint">Ver →</span>
        </div>
        {overview.season && (
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
        )}
      </Link>

      <div className="card">
        <h2 className="mini-title">Temporada</h2>
        {overview.season ? (
          <>
            <p className="hint">{diamonds(overview.seasonalDiamonds)} 💎 en tu ID ligado</p>
            <p className="hint">{daysRemaining(overview.season.endsAt)} días restantes</p>
            <Link href="/ranking" className="hint">
              Ver ranking →
            </Link>
          </>
        ) : (
          <p className="hint">Sin temporada activa.</p>
        )}
      </div>

      <Link href="/cuenta/boveda" className="hx-vault-banner" style={{ display: 'flex', marginBottom: 14 }}>
        <span className="hx-node-icon" aria-hidden="true">
          {overview.vault.unlocked ? '🔓' : '🔒'}
        </span>
        <span>
          <strong>La Bóveda</strong>
          <p className="hint" style={{ margin: '2px 0 0' }}>
            {overview.vault.unlocked
              ? `${overview.vault.offers.length} ofertas exclusivas`
              : 'Completa el Level Pass para abrir precios de temporada'}
          </p>
        </span>
        <span className="spacer" />
        <span className="hint">Ver →</span>
      </Link>

      {orders.length > 0 && (
        <section>
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
