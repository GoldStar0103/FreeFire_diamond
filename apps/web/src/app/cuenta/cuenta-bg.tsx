'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Figma midnight neon-network fondo for Mi cuenta / Level Pass.
 * Portaled to `document.body` beside AppBg; the same still is also painted
 * on `.appbg` via CSS so the background is visible before hydration.
 */
export function CuentaBg() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return createPortal(
    <div className="mc-bg" aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="mc-bg__img"
        src="/mascot/cuenta-fondo-midnight.jpg"
        alt=""
        decoding="async"
      />
    </div>,
    document.body,
  );
}
