'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Fixed top-left pill matching the design reference's `.pv-back` control.
 * Hidden on the homepage — that page shows the social profile chips in the
 * header instead — and shown on every other route. Label is "Inicio" (the
 * design mockup's "Propuestas" was review chrome, not store copy).
 */
export function ViewportBack() {
  const pathname = usePathname();
  if (!pathname || pathname === '/') return null;

  return (
    <Link href="/" className="pv-back" aria-label="Volver al inicio">
      ← Inicio
    </Link>
  );
}
