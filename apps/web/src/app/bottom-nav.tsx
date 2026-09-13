'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The fixed bottom tab bar the client's own mockups show on every screen —
 * the "apartados fijos" they asked for after the footer-only links proved too
 * easy to miss. A native-app pattern on purpose: almost all traffic is
 * phones, and a bar that survives scrolling is the one navigation a thumb
 * never has to hunt for.
 *
 * "Promociones" points at the homepage, same as "Inicio" — there is no
 * separate promotions listing yet, and pointing it at "/" is honest about
 * that rather than 404ing or duplicating the homepage under a second route.
 */
const ITEMS = [
  { href: '/', label: 'Inicio', icon: '🏠' },
  { href: '/', label: 'Promociones', icon: '🎁' },
  { href: '/pedidos', label: 'Mis pedidos', icon: '📋' },
  { href: '/confianza', label: 'Confianza', icon: '🛡️' },
  { href: '/soporte', label: 'Soporte', icon: '🎧' },
] as const;

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="bottom-nav" aria-label="Navegación principal">
      {ITEMS.map((item, i) => {
        // Both "Inicio" and "Promociones" share "/" — only the first exact
        // match highlights, so the bar never shows two tabs active at once.
        const isFirstWithThisHref = ITEMS.findIndex((x) => x.href === item.href) === i;
        const active = isFirstWithThisHref && pathname === item.href;

        return (
          <Link
            key={item.label}
            href={item.href}
            className={`bottom-nav-item${active ? ' active' : ''}`}
          >
            <span className="bottom-nav-icon" aria-hidden="true">
              {item.icon}
            </span>
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
