'use client';

import { useEffect, useRef, useState } from 'react';
import { DigitTiles } from './count-up';
import { roundDownSignificant } from '../lib/format';
import { usePrefersReducedMotion } from './use-reduced-motion';
import idle from '../assets/mascot/idle.webp';
import celebrate from '../assets/mascot/celebrate.webp';

export interface HomeActivityView {
  recargasHoy: number;
  clientes: number;
  valoracion: number | null;
}

const POLL_MS = 30_000;

function isActivity(value: unknown): value is HomeActivityView {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.recargasHoy === 'number' &&
    typeof row.clientes === 'number' &&
    (row.valoracion === null || typeof row.valoracion === 'number')
  );
}

export function LiveMetrics({ initial }: { initial: HomeActivityView }) {
  const reduced = usePrefersReducedMotion();
  const [data, setData] = useState(initial);
  const [fresh, setFresh] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pose, setPose] = useState<'idle' | 'celebrate'>('idle');
  const previous = useRef(initial.recargasHoy);

  useEffect(() => {
    let stopped = false;
    let celebrateTimer = 0;

    const tick = async () => {
      try {
        const response = await fetch('/api/actividad', { cache: 'no-store' });
        if (!response.ok) throw new Error('unavailable');
        const body: unknown = await response.json();
        if (!isActivity(body) || stopped) return;
        if (!reduced && body.recargasHoy > previous.current) {
          setPose('celebrate');
          window.clearTimeout(celebrateTimer);
          celebrateTimer = window.setTimeout(() => setPose('idle'), 2400);
        }
        previous.current = body.recargasHoy;
        setData(body);
        setFresh(true);
        setFailed(false);
      } catch {
        if (!stopped) {
          setFresh(false);
          setFailed(true);
        }
      }
    };

    const first = window.setTimeout(() => void tick(), 1500);
    const interval = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      window.clearTimeout(first);
      window.clearInterval(interval);
      window.clearTimeout(celebrateTimer);
    };
  }, [reduced]);

  const clientes = roundDownSignificant(data.clientes);
  const label = fresh ? 'En vivo' : failed ? 'Sin actualizar' : 'Hoy';

  return (
    <section className="hm-live" aria-label="Actividad de recargas">
      <span className={`hm-live-pill${fresh ? ' is-fresh' : ''}`}>
        <span className={`hm-live-dot${fresh ? '' : ' is-idle'}`} aria-hidden="true" />
        {label}
      </span>
      <div className="hm-live-stat">
        <strong>
          <DigitTiles text={String(data.recargasHoy).padStart(4, '0')} />
        </strong>
        <span>recargas hoy</span>
      </div>
      {data.valoracion !== null && (
        <div className="hm-live-stat hm-live-rating">
          <strong>★ {data.valoracion.toFixed(1)}</strong>
          <span>valoración</span>
        </div>
      )}
      {clientes > 0 && (
        <div className="hm-live-stat">
          <strong>
            <DigitTiles text={`+${clientes.toLocaleString('es-MX')}`} />
          </strong>
          <span>clientes</span>
        </div>
      )}
      <img
        className="hm-live-mascot"
        src={pose === 'celebrate' ? celebrate.src : idle.src}
        alt=""
        decoding="async"
      />
    </section>
  );
}
