'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { GiftIcon, HeadsetIcon, HomeIcon, ShieldIcon, UserIcon } from './icons';

/**
 * Jose's mockup bar, verbatim: Inicio / Promociones / Mi cuenta / Confianza /
 * Soporte. He called out the previous compromise (Mis pedidos in the fifth
 * slot) as a miss. Guest order lookup stays in the footer and on /pedidos —
 * it is not a tab on this bar.
 */
const ITEMS = [
  { href: '/', label: 'Inicio', icon: HomeIcon },
  { href: '/promociones', label: 'Promociones', icon: GiftIcon },
  { href: '/cuenta', label: 'Mi cuenta', icon: UserIcon },
  { href: '/confianza', label: 'Confianza', icon: ShieldIcon },
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
