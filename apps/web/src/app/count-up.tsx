'use client';

import { useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from './use-reduced-motion';

const DURATION_MS = 1200;

interface Props {
  value: number;
  decimals?: number;
  suffix?: string;
  tiles?: boolean;
  padDigits?: number;
}

export function DigitTiles({ text }: { text: string }) {
  return (
    <span className="hm-live-digits">
      {[...text].map((ch, i) => (
        <span key={`${i}-${ch}`} className={/\d/.test(ch) ? 'hm-live-digit' : 'hm-live-sep'}>
          {ch}
        </span>
      ))}
    </span>
  );
}

/**
 * Counts up from 0 on mount — purely cosmetic, so the client's "está en vivo
 * actualizando" numbers move once instead of arriving as flat static text.
 * The real number is always what settles on; this never fetches anything.
 */
export function CountUp({ value, decimals = 0, suffix = '', tiles = false, padDigits }: Props) {
  const reducedMotion = usePrefersReducedMotion();
  const [display, setDisplay] = useState(0);
  const start = useRef<number | null>(null);

  useEffect(() => {
    if (reducedMotion) {
      setDisplay(value);
      return;
    }
    let frame: number;
    const step = (t: number) => {
      if (start.current === null) start.current = t;
      const progress = Math.min(1, (t - start.current) / DURATION_MS);
      const eased = 1 - (1 - progress) * (1 - progress);
      setDisplay(value * eased);
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, reducedMotion]);

  let core = display.toLocaleString('es-MX', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  if (padDigits && padDigits > 0) {
    core = String(Math.round(display)).padStart(padDigits, '0');
  }
  const formatted = `${core}${suffix}`;

  if (tiles) return <DigitTiles text={formatted} />;

  return <>{formatted}</>;
}
