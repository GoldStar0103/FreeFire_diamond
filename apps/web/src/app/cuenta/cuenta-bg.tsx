'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Full-bleed neon background for Mi cuenta / Level Pass — Jose's Klickpin
 * clip from the approved redesign. Portaled to `document.body` so it sits
 * with AppBg as a true viewport-fixed layer (not trapped inside `.page.mc`'s
 * stacking context). Poster CSS on `.mc-bg` keeps the pattern visible when
 * reduced-motion hides the video.
 */
export function CuentaBg() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return createPortal(
    <div className="mc-bg" aria-hidden="true">
      <video
        className="mc-bgvid"
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        poster="/mascot/cuenta-fondo-poster.webp"
        tabIndex={-1}
      >
        <source src="/mascot/cuenta-fondo.mp4" type="video/mp4" />
      </video>
    </div>,
    document.body,
  );
}
