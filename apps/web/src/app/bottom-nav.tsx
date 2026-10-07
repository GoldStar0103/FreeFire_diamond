'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ClipboardIcon, GiftIcon, HeadsetIcon, HomeIcon, UserIcon } from './icons';

/**
 * The fixed bottom tab bar — the "apartados fijos" they asked for after
 * footer-only links proved too easy to miss. Confianza stays in the footer;
 * Cuenta sits here so players actually open Mi LevelUp (any-ID Level Pass
 * and Vault only count when they are signed in).
 */
const ITEMS = [
  { href: '/', label: 'Inicio', icon: HomeIcon },
  { href: '/promociones', label: 'Promociones', icon: GiftIcon },
  { href: '/pedidos', label: 'Mis pedidos', icon: ClipboardIcon },
  { href: '/cuenta', label: 'Cuenta', icon: UserIcon },
  { href: '/soporte', label: 'Soporte', icon: HeadsetIcon },
] as const;

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="bottom-nav" aria-label="Navegación principal">
      {ITEMS.map((item) => {
        const active = isActive(pathname, item.href);
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
