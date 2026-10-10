'use client';

import { useEffect, useState } from 'react';

/**
 * JS-driven equivalent of the `@media (prefers-reduced-motion: reduce)`
 * guards already on every CSS @keyframes animation in globals.css — for the
 * couple of effects (CountUp, BannerSlider) that CSS alone can't reach
 * because the motion comes from a timer/rAF loop, not a keyframe rule.
 *
 * Starts `false` (SSR has no `window`, and the real value arrives a tick
 * later via the effect below) rather than guessing — these are both purely
 * cosmetic one-shot/looping effects, so a caller settling into the correct
 * state one frame after mount costs nothing a user would notice.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return reduced;
}
