'use client';

import { useEffect, useRef, useState } from 'react';

const DURATION_MS = 1200;

interface Props {
  value: number;
  decimals?: number;
  suffix?: string;
}

/**
 * Counts up from 0 on mount — purely cosmetic, so the client's "está en vivo
 * actualizando" numbers move once instead of arriving as flat static text.
 * The real number is always what settles on; this never fetches anything.
 */
export function CountUp({ value, decimals = 0, suffix = '' }: Props) {
  const [display, setDisplay] = useState(0);
  const start = useRef<number | null>(null);

  useEffect(() => {
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
  }, [value]);

  return (
    <>
      {display.toLocaleString('es-MX', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
      {suffix}
    </>
  );
}
