'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ClipboardIcon, DiamondIcon, HeadsetIcon, HomeIcon, UserIcon } from './icons';

/**
 * The fixed bottom tab bar — the "apartados fijos" they asked for after
 * footer-only links proved too easy to miss.
 *
 * Labels aligned to the client's own mockups (2026-10): every one of them —
 * home, Level Pass, ranking, Mi cuenta — draws this bar as Inicio/Diamantes/
 * Mi perfil/Confianza/Soporte, not what this file had. Matched where it is a
 * pure relabelling (Cuenta -> Mi perfil, same destination; Promociones ->
 * Diamantes, same destination — hexzrecargas.com's own equivalent tab is
 * "Recargas", the same purchase-framing over campaign-framing) but NOT
 * copied wholesale: the mockup's 5 slots have no "Mis pedidos", yet
 * apps/web/src/app/pedidos/page.tsx is a real, necessary feature with no
 * substitute reachable from here — a guest order-lookup form for a buyer who
 * checked out without a Mi LevelUp account, a different audience from
 * Mi perfil's own embedded order history (account holders only). Dropping it
 * to free a 6th slot for Confianza would be a real reachability regression
 * for no actual gain, so it stays, and Confianza stays footer-only exactly
 * as this file already reasoned.
 */
const ITEMS = [
  { href: '/', label: 'Inicio', icon: HomeIcon },
  { href: '/promociones', label: 'Diamantes', icon: DiamondIcon },
  { href: '/pedidos', label: 'Mis pedidos', icon: ClipboardIcon },
  { href: '/cuenta', label: 'Mi perfil', icon: UserIcon },
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
