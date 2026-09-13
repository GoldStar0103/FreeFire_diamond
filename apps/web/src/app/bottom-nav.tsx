'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ClipboardIcon, GiftIcon, HeadsetIcon, HomeIcon, ShieldIcon } from './icons';

/**
 * The fixed bottom tab bar the client's own mockups show on every screen —
 * the "apartados fijos" they asked for after the footer-only links proved too
 * easy to miss. A native-app pattern on purpose: almost all traffic is
 * phones, and a bar that survives scrolling is the one navigation a thumb
 * never has to hunt for.
 */
const ITEMS = [
  { href: '/', label: 'Inicio', icon: HomeIcon },
  { href: '/promociones', label: 'Promociones', icon: GiftIcon },
  { href: '/pedidos', label: 'Mis pedidos', icon: ClipboardIcon },
  { href: '/confianza', label: 'Confianza', icon: ShieldIcon },
  { href: '/soporte', label: 'Soporte', icon: HeadsetIcon },
] as const;

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="bottom-nav" aria-label="Navegación principal">
      {ITEMS.map((item) => {
        const active = pathname === item.href;
        const Icon = item.icon;

        return (
          <Link
            key={item.label}
            href={item.href}
            className={`bottom-nav-item${active ? ' active' : ''}`}
          >
            <span className="bottom-nav-icon">
              <Icon className="icon" />
            </span>
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
