import type { Metadata } from 'next';
import Link from 'next/link';
import { getMyLevelUpOverview } from '@levelup/db';
import { getCustomerSession } from '../../../lib/customer-session.js';
import { getDb } from '../../../lib/server.js';
import { dateLabel, diamonds } from '../../../lib/format.js';
import { ChestMark, ClockIcon, CrownIcon, DiamondIcon, GemMark, LockIcon } from '../../icons';
import { MascotMedia } from '../../mascot-media';
import { SiteHeader } from '../../site-header';
import { CuentaBg } from '../cuenta-bg';
import { CuentaForm } from '../cuenta-form';
import cuentaStill from '../../../assets/mascot/cuenta-still.webp';

export const metadata: Metadata = {
  title: 'Level Pass',
  description: 'Tu progreso, tus checkpoints y tus recompensas de la temporada.',
  alternates: { canonical: '/cuenta/level-pass' },
};

export const dynamic = 'force-dynamic';

function daysRemaining(endsAt: Date): number {
  return Math.max(0, Math.ceil((endsAt.getTime() - Date.now()) / 86_400_000));
}

const MASCOT_PROPS = {
  webm: '/mascot/mi-cuenta-luchador.webm',
  animWebp: '/mascot/mi-cuenta-luchador-anim.webp',
  stillSrc: cuentaStill.src,
  alt: 'Luchador de LevelUp sosteniendo un diamante',
};

export default async function LevelPassPage() {
  const session = await getCustomerSession();

  if (!session) {
    return (
      <main className="page narrow mc">
      <CuentaBg />
        <SiteHeader />
        <section className="lp-hero">
          <div className="txt">
            <Link href="/cuenta" className="lp-back">
              ← Mi cuenta
            </Link>
            <span className="mc-eyebrow">
              <CrownIcon className="icon" />
              Level Pass
            </span>
            <h1>
              Recarga diamantes,
              <br />
              <em>gana recompensas</em>
            </h1>
            <p>Entra con tu correo para ver tu progreso.</p>
          </div>
          <span className="mc-halo" aria-hidden="true" />
          <MascotMedia className="mc-hero-mascot" {...MASCOT_PROPS} />
        </section>
        <CuentaForm />
      </main>
    );
  }

  const overview = await getMyLevelUpOverview(getDb(), session.playerProfileId);

  if (!overview.season) {
    return (
      <main className="page narrow mc">
      <CuentaBg />
        <SiteHeader />
        <Link href="/cuenta" className="lp-back">
          ← Mi cuenta
        </Link>
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
    <main className="page narrow mc">
      <CuentaBg />
      <SiteHeader />

      <section className="lp-hero">
        <div className="txt">
          <Link href="/cuenta" className="lp-back">
            ← Mi cuenta
          </Link>
          <span className="mc-eyebrow">
            <CrownIcon className="icon" />
            Level Pass · Temporada {season.seasonNumber}
          </span>
          <h1>
            Recarga diamantes,
            <br />
            <em>gana recompensas</em>
          </h1>
          <p>Cada recarga suma Level Points. Completa el Pass y se abre La Bóveda.</p>
          <span className="chip-dias">
            <ClockIcon className="icon" />
            {days} día{days === 1 ? '' : 's'} restantes
          </span>
        </div>
        <span className="mc-halo" aria-hidden="true" />
        <MascotMedia className="mc-hero-mascot" {...MASCOT_PROPS} />
      </section>

      <div className="ganas">
        <div className="gana">
          <span className="ic">
            <DiamondIcon className="icon" />
          </span>
          <b>Suma Level Points</b>
        </div>
        <div className="gana">
          <span className="ic">
            <GemMark className="icon" />
          </span>
          <b>Desbloquea recompensas</b>
        </div>
        <div className="gana">
          <span className="ic">
            <LockIcon className="icon" />
          </span>
          <b>Accede a La Bóveda</b>
        </div>
      </div>

      <div className="prog">
        <div className="cab">
          <h2>Tu progreso</h2>
          {nextCheckpoint && <span className="pct">{Math.round(pct)}%</span>}
        </div>
        <div className="num">
          {overview.lp}
          {nextCheckpoint && <small>/ {nextCheckpoint.lp} LP</small>}
        </div>
        <div className="barra" role="img" aria-label={`Nivel de pase: ${overview.lp} de ${nextCheckpoint?.lp ?? overview.lp} LP`}>
          <i style={{ width: `${pct}%` }} />
        </div>
        {nextCheckpoint ? (
          <div className="prox">
            <ClockIcon className="icon" />
            Siguiente recompensa: <b>{diamonds(nextCheckpoint.rewardDiamonds)} 💎</b> ·{' '}
            {nextCheckpoint.lp - overview.lp} LP restantes
          </div>
        ) : (
          <div className="prox">Completaste el Level Pass de esta temporada.</div>
        )}
      </div>

      <div className="cp-wrap">
        <ul className="cp">
          {sorted.map((cp) => {
            const isCurrent = !cp.reached && cp.lp === nextCheckpoint?.lp;
            const isFinal = finalCheckpoint?.lp === cp.lp;
            const done = cp.status === 'granted' || cp.status === 'pending';
            const cls = [isCurrent && 'sig', isFinal && 'fin', done && 'done'].filter(Boolean).join(' ');
            const label = cp.status === 'granted'
              ? 'Reclamada'
              : cp.status === 'pending'
                ? 'En camino'
                : cp.status === 'reversed'
                  ? 'No disponible'
                  : isCurrent
                    ? 'Siguiente'
                    : 'Bloqueada';

            return (
              <li key={cp.lp} className={`nodo ${cls}`}>
                <span className="dot">{isFinal ? <ChestMark className="icon" /> : <GemMark className="icon" />}</span>
                <b>{cp.lp.toLocaleString('es-MX')} LP</b>
                <span>
                  {diamonds(cp.rewardDiamonds)} 💎{isFinal && <em> + La Bóveda</em>}
                </span>
                <span className="est">{label}</span>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="banda">
        <div className="dato lp">
          <span className="ic">
            <CrownIcon className="icon" />
          </span>
          <b>{overview.lp}</b>
          <span className="lbl">LP esta temporada</span>
        </div>
        <div className="dato diam">
          <span className="ic">
            <DiamondIcon className="icon" />
          </span>
          <b>{diamonds(overview.seasonalDiamonds)}</b>
          <span className="lbl">diamantes recargados</span>
        </div>
        <div className="dato dias">
          <span className="ic">
            <ClockIcon className="icon" />
          </span>
          <b>{days}</b>
          <span className="lbl">días restantes</span>
        </div>
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
                ? `${overview.vault.offers.length} oferta${overview.vault.offers.length === 1 ? '' : 's'} disponible${overview.vault.offers.length === 1 ? '' : 's'}`
                : 'Completa el Level Pass para desbloquear precios exclusivos.'}
            </p>
          </div>
          <span className="ver">Ver →</span>
        </div>
      </Link>

      {sorted.some((c) => c.reached) && (
        <section style={{ marginTop: 18 }}>
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
        </section>
      )}
    </main>
  );
}
