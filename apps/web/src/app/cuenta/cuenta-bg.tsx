'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Full-bleed neon fondo for Mi cuenta / Level Pass. Portaled to
 * `document.body` so it sits with AppBg as a viewport-fixed layer.
 * Static image (not the old Klickpin video) so the pattern matches the
 * approved neon still and stays visible under reduced-motion.
 */
export function CuentaBg() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return createPortal(<div className="mc-bg" aria-hidden="true" />, document.body);
}
