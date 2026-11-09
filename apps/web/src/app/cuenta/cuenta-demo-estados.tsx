'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { CartIcon, ClockIcon, CrownIcon, DiamondIcon, LockIcon } from '../icons';

type Vista = 'login' | 'dash';
type Boveda = 'cerrada' | 'abierta';

/**
 * Design-sample prototype switcher from mi-cuenta.html — lets reviewers
 * flip between the login card and a static logged-in preview (incl. vault).
 */
export function CuentaDemoEstados({ login }: { login: ReactNode }) {
  const [vista, setVista] = useState<Vista>('login');
  const [boveda, setBoveda] = useState<Boveda>('cerrada');

  return (
    <>
      {vista === 'login' ? login : <DemoDash boveda={boveda} />}

      <div className="demo-estados" role="group" aria-label="Vista de cuenta, solo prototipo">
        <span>Vista de cuenta · solo prototipo</span>
        <button
          type="button"
          aria-pressed={vista === 'login'}
          onClick={() => {
            setVista('login');
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        >
          Entrar con correo
        </button>
        <button
          type="button"
          aria-pressed={vista === 'dash'}
          onClick={() => {
            setVista('dash');
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        >
          Con sesión
        </button>
        <button
          type="button"
          aria-pressed={boveda === 'cerrada'}
          onClick={() => setBoveda('cerrada')}
        >
          Bóveda cerrada
        </button>
        <button
          type="button"
          aria-pressed={boveda === 'abierta'}
          onClick={() => setBoveda('abierta')}
        >
          Bóveda abierta
        </button>
      </div>
    </>
  );
}

function DemoDash({ boveda }: { boveda: Boveda }) {
  const abierta = boveda === 'abierta';

  return (
    <div id="vista-dash-demo">
      <section className="jugador">
        <div className="jg-top">
          <span className="mc-avatar" aria-hidden="true">
            <DiamondIcon className="icon diam" />
            <span className="corona">
              <CrownIcon className="icon" />
            </span>
          </span>
          <div>
            <div className="jg-name">
              <b>Jugador 15867717</b>
            </div>
            <span className="jg-id">ID de temporada 15867717</span>
          </div>
        </div>
        <div className="jg-pills">
          <span className="pill">Posición #179</span>
          <span className="pill">39 días</span>
          <span className="pill lock">
            <LockIcon className="icon" />
            {abierta ? 'Bóveda abierta' : 'Bóveda cerrada'}
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
          <b>620</b>
          <span>diamantes históricos</span>
        </div>
        <div className="stat">
          <span className="ic">
            <CartIcon className="icon" />
          </span>
          <b>2</b>
          <span>recargas</span>
        </div>
        <div className="stat lp">
          <span className="ic lp-ic">
            <b>LP</b>
          </span>
          <b>15</b>
          <span>LP esta temporada</span>
        </div>
      </div>

      <Link href="/cuenta/insignias" className="insignias">
        Elige tus insignias destacadas
        <span className="arw">→</span>
      </Link>

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
        <p className="lp-sub">
          <b>15</b> / 60 LP · siguiente 110 💎
        </p>
        <div className="barra" role="img" aria-label="Nivel de pase: 15 de 60 LP">
          <i style={{ width: '25%' }} />
        </div>
      </Link>

      <div className="temp">
        <h3>
          <span className="ic">
            <ClockIcon className="icon" />
          </span>
          Temporada
        </h3>
        <ul>
          <li>
            <DiamondIcon className="icon" />
            <b>620</b>&nbsp;en tu ID ligado
          </li>
          <li>
            <ClockIcon className="icon" />
            <b>39</b>&nbsp;días restantes
          </li>
        </ul>
        <Link href="/ranking" className="btn-rank">
          Ver ranking de la temporada
          <span className="arw">→</span>
        </Link>
      </div>

      <div className="boveda" data-estado={abierta ? 'abierta' : 'cerrada'}>
        <div className="in">
          <span className="cofre" aria-hidden="true">
            <LockIcon className="icon" />
          </span>
          <div className="txt">
            <h3>
              La Bóveda{' '}
              <span className="chip-estado">{abierta ? 'Desbloqueada' : 'Bloqueada'}</span>
            </h3>
            <p>
              {abierta
                ? 'Ya abriste los precios de temporada. Tienes hasta el cierre para usarlos.'
                : 'Completa el Level Pass para abrir precios de temporada.'}
            </p>
          </div>
          <Link href="/cuenta/boveda" className="ver">
            Ver→
          </Link>
        </div>
      </div>
    </div>
  );
}
