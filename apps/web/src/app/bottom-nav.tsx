'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The fixed bottom tab bar the client's own mockups show on every screen —
 * the "apartados fijos" they asked for after the footer-only links proved too
 * easy to miss. A native-app pattern on purpose: almost all traffic is
 * phones, and a bar that survives scrolling is the one navigation a thumb
 * never has to hunt for.
 */
const ITEMS = [
  { href: '/', label: 'Inicio', icon: '🏠' },
  { href: '/promociones', label: 'Promociones', icon: '🎁' },
  { href: '/pedidos', label: 'Mis pedidos', icon: '📋' },
  { href: '/confianza', label: 'Confianza', icon: '🛡️' },
  { href: '/soporte', label: 'Soporte', icon: '🎧' },
] as const;

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="bottom-nav" aria-label="Navegación principal">
      {ITEMS.map((item) => {
        const active = pathname === item.href;

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
