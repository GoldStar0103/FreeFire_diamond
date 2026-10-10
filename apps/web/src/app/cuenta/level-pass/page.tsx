import type { Metadata } from 'next';
import Link from 'next/link';
import { getMyLevelUpOverview } from '@levelup/db';
import { getCustomerSession } from '../../../lib/customer-session.js';
import { getDb } from '../../../lib/server.js';
import { dateLabel, diamonds } from '../../../lib/format.js';
import mascot from '../../../assets/mascot.webp';
import { ChestMark, GemMark } from '../../icons';
import { CuentaForm } from '../cuenta-form';

export const metadata: Metadata = {
  title: 'Level Pass',
  description: 'Tu progreso, tus checkpoints y tus recompensas de la temporada.',
  alternates: { canonical: '/cuenta/level-pass' },
};

export const dynamic = 'force-dynamic';

function daysRemaining(endsAt: Date): number {
  return Math.max(0, Math.ceil((endsAt.getTime() - Date.now()) / 86_400_000));
}

export default async function LevelPassPage() {
  const session = await getCustomerSession();

  if (!session) {
    return (
      <main className="page narrow">
        <section className="hx-hero" style={{ minHeight: 240, marginLeft: 0, marginRight: 0 }}>
          <div className="hx-hero-copy hx-rise">
            <p className="hx-kicker">Level Pass</p>
            <h1>
              Recarga diamantes, <span className="grad">gana recompensas</span>
            </h1>
            <p className="hx-hero-lead">Entra con tu correo para ver tu progreso.</p>
          </div>
          <div className="hx-mascot hx-rise-2" aria-hidden="true">
            <div className="hx-mascot-glow" />
            <img src={mascot.src} alt="" decoding="async" />
          </div>
        </section>
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
  const sorted = overview.checkpoints;
  const finalCheckpoint = sorted.at(-1);
  const nextCheckpoint = sorted.find((c) => !c.reached);
  const days = daysRemaining(season.endsAt);
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

      <section className="hx-hero" style={{ minHeight: 260, marginLeft: 0, marginRight: 0, paddingTop: 8 }}>
        <div className="hx-hero-copy hx-rise">
          <p className="hx-kicker">
            Level Pass · Temporada {season.seasonNumber}
          </p>
          <h1>
            Recarga diamantes, <span className="grad">gana recompensas</span>
          </h1>
          <p className="hx-hero-lead">
            Cada recarga suma Level Points. Completa el Pass y se abre La Bóveda.
          </p>
          <span className="season-pill">{days} día{days === 1 ? '' : 's'} restantes</span>
        </div>
        <div className="hx-mascot hx-rise-2" aria-hidden="true">
          <div className="hx-mascot-glow" />
          <span className="hx-orb a" />
          <span className="hx-orb b" />
          <img src={mascot.src} alt="" decoding="async" />
        </div>
      </section>

      <div className="card hx-pass hx-rise-3">
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
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
        {nextCheckpoint ? (
          <p className="hint" style={{ marginTop: 8 }}>
            Siguiente recompensa: <strong>{diamonds(nextCheckpoint.rewardDiamonds)} 💎</strong> ·{' '}
            {nextCheckpoint.lp - overview.lp} LP restantes
          </p>
        ) : (
          <p className="hint" style={{ marginTop: 8 }}>
            Completaste el Level Pass de esta temporada.
          </p>
        )}
      </div>

      <h2 className="section-title">Checkpoints</h2>
      <div className="hx-track">
        {sorted.map((cp) => {
          const isCurrent = !cp.reached && cp.lp === nextCheckpoint?.lp;
          const isFinal = finalCheckpoint?.lp === cp.lp;
          let state: 'granted' | 'current' | 'pending' | 'locked' | 'reversed';
          if (cp.status === 'granted') state = 'granted';
          else if (cp.status === 'reversed') state = 'reversed';
          else if (cp.reached) state = 'pending';
          else if (isCurrent) state = 'current';
          else state = 'locked';

          return (
            <div key={cp.lp} className={`hx-node ${state}`}>
              <div className="hx-node-icon" aria-hidden="true">
                {isFinal ? <ChestMark className="icon" /> : <GemMark className="icon" />}
              </div>
              <div className="hx-node-lp">{cp.lp.toLocaleString('es-MX')} LP</div>
              <div className="hx-node-reward">
                {diamonds(cp.rewardDiamonds)} 💎
                {isFinal && <div className="hint">+ La Bóveda</div>}
              </div>
              <div className="hx-node-status">
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

      <div className="card hx-statbar" style={{ marginTop: 18 }}>
        <div className="counter">
          <div className="counter-value">{overview.lp}</div>
          <div className="counter-label">LP esta temporada</div>
        </div>
        <div className="counter">
          <div className="counter-value">{diamonds(overview.seasonalDiamonds)}</div>
          <div className="counter-label">diamantes recargados</div>
        </div>
        <div className="counter">
          <div className="counter-value">{days}</div>
          <div className="counter-label">días restantes</div>
        </div>
      </div>

      <Link href="/cuenta/boveda" className="hx-vault-banner" style={{ marginBottom: 16 }}>
        <span className="hx-node-icon" aria-hidden="true">
          <ChestMark className="icon" />
        </span>
        <span>
          <strong>La Bóveda</strong>
          <p className="hint" style={{ margin: '2px 0 0' }}>
            {overview.vault.unlocked
              ? `${overview.vault.offers.length} oferta${overview.vault.offers.length === 1 ? '' : 's'} disponible${overview.vault.offers.length === 1 ? '' : 's'}`
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
