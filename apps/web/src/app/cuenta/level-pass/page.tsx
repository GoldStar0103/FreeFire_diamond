import type { Metadata } from 'next';
import Link from 'next/link';
import { getMyLevelUpOverview } from '@levelup/db';
import { getCustomerSession } from '../../../lib/customer-session.js';
import { getDb } from '../../../lib/server.js';
import { diamonds } from '../../../lib/format.js';
import { CuentaForm } from '../cuenta-form';

export const metadata: Metadata = {
  title: 'Level Pass',
  description: 'Tu progreso, tus checkpoints y tus recompensas de la temporada.',
  alternates: { canonical: '/cuenta/level-pass' },
};

export const dynamic = 'force-dynamic';

const dateLabel = (d: Date) => new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium' }).format(d);

function daysRemaining(endsAt: Date): number {
  return Math.max(0, Math.ceil((endsAt.getTime() - Date.now()) / 86_400_000));
}

export default async function LevelPassPage() {
  const session = await getCustomerSession();

  if (!session) {
    return (
      <main className="page narrow">
        <h1 className="page-title">Level Pass</h1>
        <p className="page-sub">Entra con tu correo para ver tu progreso.</p>
        <CuentaForm />
      </main>
    );
  }

  const overview = await getMyLevelUpOverview(getDb(), session.playerProfileId);

  if (!overview.season) {
    return (
      <main className="page narrow">
        <p className="hint" style={{ marginBottom: 8 }}>
          <Link href="/cuenta">← Mi cuenta</Link>
        </p>
        <h1 className="page-title">Level Pass</h1>
        <p className="page-sub">Todavía no hay una temporada activa. Vuelve cuando empiece la próxima.</p>
      </main>
    );
  }

  const { season } = overview;
  const sorted = overview.checkpoints; // already ascending by lp
  const finalCheckpoint = sorted.at(-1);
  const nextCheckpoint = sorted.find((c) => !c.reached);
  const passCompleted = !nextCheckpoint && sorted.length > 0;
  const days = daysRemaining(season.endsAt);

  // Progress toward the NEXT checkpoint specifically, not the whole Pass — the
  // bar's own ends are "where you were" and "where you're going", not 0 and
  // the final checkpoint, so it stays meaningful at every stage.
  const prevThreshold = (() => {
    const idx = sorted.findIndex((c) => c.lp === nextCheckpoint?.lp);
    return idx > 0 ? sorted[idx - 1]!.lp : 0;
  })();
  const span = nextCheckpoint ? nextCheckpoint.lp - prevThreshold : 1;
  const into = nextCheckpoint ? overview.lp - prevThreshold : 0;
  const pct = nextCheckpoint ? Math.max(0, Math.min(100, (into / span) * 100)) : 100;

  return (
    <main className="page narrow">
      <p className="hint" style={{ marginBottom: 8 }}>
        <Link href="/cuenta">← Mi cuenta</Link>
      </p>

      {/*
        No illustrated key art yet — that's a content asset for the client to
        supply later through the same upload pipeline campaign flyers already
        use (see mega-flyer-link), not something to hardcode here. This panel
        is built to take that image as a background without any further
        restructuring once it exists; until then the hex/diamond motif reads
        as deliberate on its own.
      */}
      <div className="lp-hero">
        <div className="lp-hero-top">
          <h1 className="page-title lp-hero-title">Level Pass</h1>
          <details className="lp-how">
            <summary>¿Cómo funciona?</summary>
            <p>
              Compra diamantes y gana Level Points automáticamente. Progresa durante la temporada,
              desbloquea recompensas en cada checkpoint y completa el Pass para abrir La Bóveda.
            </p>
          </details>
        </div>
        <p className="hint" style={{ marginTop: 2 }}>Temporada {season.seasonNumber}</p>
        <span className="season-pill">⏱ {days} día{days === 1 ? '' : 's'} restantes</span>
      </div>

      <div className="card lp-progress-card">
        <div className="row" style={{ alignItems: 'baseline' }}>
          <span className="hint">Tu progreso</span>
          <div className="spacer" />
          {nextCheckpoint && <span className="hint">{Math.round(pct)}%</span>}
        </div>
        <div className="lp-progress-value">
          {overview.lp}
          {nextCheckpoint && <span className="hint"> / {nextCheckpoint.lp} LP</span>}
        </div>
        <div className="progress-track">
          <div className="progress-fill lp-progress-fill" style={{ width: `${pct}%` }} />
        </div>
        {nextCheckpoint ? (
          <p className="hint" style={{ marginTop: 8 }}>
            Siguiente recompensa: <strong>{diamonds(nextCheckpoint.rewardDiamonds)} 💎</strong> ·{' '}
            {nextCheckpoint.lp - overview.lp} LP restantes
          </p>
        ) : (
          <p className="hint" style={{ marginTop: 8 }}>¡Completaste el Level Pass de esta temporada! 🎉</p>
        )}
      </div>

      <h2 className="section-title">Checkpoints</h2>
      <div className="lp-track">
        {sorted.map((cp) => {
          const isCurrent = !cp.reached && cp.lp === nextCheckpoint?.lp;
          const isFinal = finalCheckpoint?.lp === cp.lp;
          let state: 'granted' | 'current' | 'pending' | 'locked' | 'reversed';
          if (cp.status === 'granted') state = 'granted';
          else if (cp.status === 'reversed') state = 'reversed';
          else if (cp.reached) state = 'pending'; // reached, auto-delivery in progress
          else if (isCurrent) state = 'current';
          else state = 'locked';

          return (
            <div key={cp.lp} className={`lp-node lp-node-${state}`}>
              <div className="lp-node-icon" aria-hidden="true">
                {state === 'granted' && '✓'}
                {state === 'current' && '★'}
                {state === 'pending' && '⏳'}
                {state === 'locked' && '🔒'}
                {state === 'reversed' && '–'}
              </div>
              <div className="lp-node-lp">{cp.lp.toLocaleString('es-MX')} LP</div>
              <div className="lp-node-reward">
                {diamonds(cp.rewardDiamonds)} 💎
                {isFinal && <div className="hint">+ Acceso a La Bóveda</div>}
              </div>
              <div className={`lp-node-status lp-node-status-${state}`}>
                {state === 'granted' && 'Reclamada'}
                {state === 'current' && 'Siguiente'}
                {state === 'pending' && 'En camino'}
                {state === 'locked' && 'Bloqueada'}
                {state === 'reversed' && 'No disponible'}
              </div>
            </div>
          );
        })}
      </div>

      <div className="stats-row" style={{ marginTop: 18 }}>
        <div className="card counter">
          <div className="counter-value">{overview.lp}</div>
          <div className="counter-label">LP esta temporada</div>
        </div>
        <div className="card counter">
          <div className="counter-value">{diamonds(overview.seasonalDiamonds)}</div>
          <div className="counter-label">💎 recargados</div>
        </div>
        <div className="card counter">
          <div className="counter-value">{days}</div>
          <div className="counter-label">días restantes</div>
        </div>
      </div>

      <Link href="/cuenta/boveda" className={`card lp-vault-teaser${overview.vault.unlocked ? ' unlocked' : ''}`}>
        <span className="lp-vault-icon" aria-hidden="true">{overview.vault.unlocked ? '🔓' : '🔒'}</span>
        <span>
          <strong>La Bóveda</strong>
          <p className="hint" style={{ margin: '2px 0 0' }}>
            {overview.vault.unlocked
              ? `Desbloqueada — ${overview.vault.offers.length} oferta${overview.vault.offers.length === 1 ? '' : 's'} disponible${overview.vault.offers.length === 1 ? '' : 's'}`
              : 'Completa el Level Pass para desbloquear precios exclusivos.'}
          </p>
        </span>
        <span className="spacer" />
        <span className="hint">Ver →</span>
      </Link>

      {sorted.some((c) => c.reached) && (
        <>
          <h2 className="section-title">Tus recompensas de la temporada</h2>
          {sorted
            .filter((c) => c.reached)
            .map((cp) => (
              <div key={cp.lp} className="card lp-history-row">
                <span>
                  {diamonds(cp.rewardDiamonds)} 💎
                  <span className="hint"> · Checkpoint {cp.lp.toLocaleString('es-MX')} LP</span>
                </span>
                <span className="spacer" />
                <span className={`hint lp-history-status lp-history-status-${cp.status}`}>
                  {cp.status === 'granted' && `Reclamada · ${cp.grantedAt ? dateLabel(cp.grantedAt) : ''}`}
                  {cp.status === 'pending' && 'En camino'}
                  {cp.status === 'reversed' && 'No disponible'}
                </span>
              </div>
            ))}
        </>
      )}
    </main>
  );
}
