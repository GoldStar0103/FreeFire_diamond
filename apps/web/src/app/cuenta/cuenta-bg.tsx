'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Full-bleed midnight neon-network fondo for Mi cuenta / Level Pass.
 * Portaled to `document.body` so it sits with AppBg as a viewport-fixed
 * layer. Uses the Figma still (`cuenta-fondo-midnight.jpg`).
 */
export function CuentaBg() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return createPortal(<div className="mc-bg" aria-hidden="true" />, document.body);
}
