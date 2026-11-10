import type { Metadata } from 'next';
import Link from 'next/link';
import { getMyLevelUpOverview, getMyProfile, listMyOrders } from '@levelup/db';
import { getCustomerSession } from '../../lib/customer-session.js';
import { getDb } from '../../lib/server.js';
import { avatarUrl } from '../../lib/assets.js';
import { diamonds, mxn } from '../../lib/format.js';
import { CartIcon, ClockIcon, CrownIcon, DiamondIcon, LockIcon } from '../icons';
import { MascotMedia } from '../mascot-media';
import { SiteHeader } from '../site-header';
import { CuentaBg } from './cuenta-bg';
import { CuentaForm } from './cuenta-form';
import { logout } from './profile-actions';
import cuentaStill from '../../assets/mascot/cuenta-still.webp';

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

/** Matches the mockup's 3-tone order treatment: green done, amber in flight, red stalled. */
function orderTone(status: string): 'ok' | 'o' | 'e' {
  if (status === 'completed') return 'ok';
  if (['payment_expired', 'cancelled', 'refunded'].includes(status)) return 'e';
  return 'o';
}

function daysRemaining(endsAt: Date): number {
  return Math.max(0, Math.ceil((endsAt.getTime() - Date.now()) / 86_400_000));
}

export default async function CuentaPage() {
  const session = await getCustomerSession();

  if (!session) {
    return (
      <main className="page mc">
        <CuentaBg />
        <SiteHeader />
        <section className="mc-head" aria-labelledby="mc-titulo">
          <div className="mc-txt">
            <span className="mc-eyebrow">
              <CrownIcon className="icon" />
              Mi cuenta
            </span>
            <h1 id="mc-titulo">
              Tu temporada,
              <br />
              <em>en un solo lugar</em>
            </h1>
            <p>
              Entra con tu correo — sin contraseña. Un ID para el ranking. Cualquier recarga con
              tu cuenta suma al Level Pass y La Bóveda.
            </p>
          </div>
          <div className="mc-hero">
            <span className="mc-halo" aria-hidden="true" />
            <MascotMedia
              className="mc-hero-mascot"
              webm="/mascot/mi-cuenta-luchador.webm"
              animWebp="/mascot/mi-cuenta-luchador-anim.webp"
              stillSrc={cuentaStill.src}
              alt="Luchador de LevelUp sosteniendo un diamante"
            />
          </div>
        </section>
        <CuentaForm />
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
      <main className="page mc">
        <CuentaBg />
        <SiteHeader />
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
    <main className="page mc">
      <CuentaBg />
      <SiteHeader />

      <section className="jugador">
        <div className="jg-top">
          <span className="mc-avatar" aria-hidden="true">
            {avatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={avatar} alt="" width={64} height={64} />
            ) : (
              <DiamondIcon className="icon diam" />
            )}
            <span className="corona">
              <CrownIcon className="icon" />
            </span>
          </span>
          <div>
            <div className="jg-name">
              <b>{name}</b>
              <Link href="/cuenta/perfil" className="edit" aria-label="Editar nombre">
                ✎
              </Link>
            </div>
            <span className="jg-id">ID de temporada {profile.playerId}</span>
          </div>
        </div>
        <div className="jg-pills">
          {overview.season && overview.rank && <span className="pill">Posición #{overview.rank}</span>}
          {seasonDays !== null && (
            <span className="pill">
              {seasonDays} día{seasonDays === 1 ? '' : 's'}
            </span>
          )}
          <span className="pill lock">
            <LockIcon className="icon" />
            {overview.vault.unlocked ? 'Bóveda abierta' : 'Bóveda cerrada'}
          </span>
        </div>
        <Link href="/cuenta/perfil" className="btn-edit">
          Editar perfil
        </Link>
        <p className="jg-nota">Recargas a otros IDs también suman LP y La Bóveda.</p>
      </section>

      <div className="stats3">
        <div className="stat">
          <span className="ic">
            <DiamondIcon className="icon" />
          </span>
          <b>{diamonds(profile.lifetimeDiamondsPurchased)}</b>
          <span>diamantes históricos</span>
        </div>
        <div className="stat">
          <span className="ic">
            <CartIcon className="icon" />
          </span>
          <b>{profile.lifetimeRechargeCount}</b>
          <span>recargas</span>
        </div>
        <div className="stat lp">
          <span className="ic lp-ic">
            <b>LP</b>
          </span>
          <b>{overview.lp}</b>
          <span>LP esta temporada</span>
        </div>
      </div>

      {overview.featuredBadges.length > 0 ? (
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
      ) : (
        <Link href="/cuenta/insignias" className="insignias">
          Elige tus insignias destacadas
          <span className="arw">→</span>
        </Link>
      )}

      <Link href="/cuenta/level-pass" className="lp-card">
        <div className="lp-head">
          <span className="lp-badge">
            <b>LP</b>
          </span>
          <h3>Level Pass</h3>
          <span className="ver">
            Ver<span className="arw">→</span>
          </span>
        </div>
        {overview.season ? (
          <p className="lp-sub">
            <b>{overview.lp}</b> / {nextCheckpoint ? nextCheckpoint.lp : overview.lp} LP
            {nextCheckpoint ? ` · siguiente ${diamonds(nextCheckpoint.rewardDiamonds)} 💎` : ' · Pass completado'}
          </p>
        ) : (
          <p className="lp-sub">Todavía no hay una temporada activa.</p>
        )}
        {overview.season && (
          <div className="barra" role="img" aria-label={`Nivel de pase: ${overview.lp} de ${nextCheckpoint?.lp ?? overview.lp} LP`}>
            <i style={{ width: `${pct}%` }} />
          </div>
        )}
      </Link>

      <div className="temp">
        <h3>
          <span className="ic">
            <ClockIcon className="icon" />
          </span>
          Temporada
        </h3>
        {overview.season ? (
          <>
            <ul>
              <li>
                <DiamondIcon className="icon" />
                <b>{diamonds(overview.seasonalDiamonds)}</b>&nbsp;en tu ID ligado
              </li>
              <li>
                <ClockIcon className="icon" />
                <b>{daysRemaining(overview.season.endsAt)}</b>&nbsp;días restantes
              </li>
            </ul>
            <Link href="/ranking" className="btn-rank">
              Ver ranking de la temporada
              <span className="arw">→</span>
            </Link>
          </>
        ) : (
          <p className="hint">Sin temporada activa.</p>
        )}
      </div>

      <Link href="/cuenta/boveda" className="boveda" data-estado={overview.vault.unlocked ? 'abierta' : 'cerrada'}>
        <div className="in">
          <span className="cofre" aria-hidden="true">
            <LockIcon className="icon" />
          </span>
          <div className="txt">
            <h3>
              La Bóveda{' '}
              <span className="chip-estado">{overview.vault.unlocked ? 'Desbloqueada' : 'Bloqueada'}</span>
            </h3>
            <p>
              {overview.vault.unlocked
                ? `${overview.vault.offers.length} ofertas exclusivas`
                : 'Completa el Level Pass para abrir precios de temporada'}
            </p>
          </div>
          <span className="ver">Ver→</span>
        </div>
      </Link>

      {orders.length > 0 && (
        <section className="pedidos">
          <div className="cab">
            <i aria-hidden="true" />
            <h2>Tus pedidos recientes</h2>
          </div>
          {orders.map((o) => (
            <Link
              key={o.orderNumber}
              href={`/pedido/${o.orderNumber}?id=${encodeURIComponent(o.playerId)}`}
              className={`pedido ${orderTone(o.status)}`}
            >
              <span className="carro">
                <CartIcon className="icon" />
              </span>
              <div className="datos">
                <div className="id">{o.orderNumber}</div>
                <span className="det">{o.comboName}</span>
              </div>
              <div className="der">
                <div className="monto">{mxn(o.priceMxnCents)}</div>
                <span className="est">{ORDER_STATUS_LABELS[o.status] ?? o.status}</span>
                {o.lpEarned !== null && <span className="lp">+{o.lpEarned} LP</span>}
              </div>
              <span className="arw">→</span>
            </Link>
          ))}
        </section>
      )}

      <form action={logout} style={{ marginTop: orders.length > 0 ? 0 : 20 }}>
        <button className="cerrar" type="submit">
          Cerrar sesión
          <span className="arw">→</span>
        </button>
      </form>
    </main>
  );
}
