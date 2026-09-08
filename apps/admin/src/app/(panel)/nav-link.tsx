'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function NavLink({
  href,
  children,
  count,
}: {
  href: string;
  children: React.ReactNode;
  count?: number;
}) {
  const pathname = usePathname();
  // "/" would otherwise match every route.
  const active = href === '/' ? pathname === '/' : pathname.startsWith(href);

  return (
    <Link href={href} className={active ? 'nav-link active' : 'nav-link'}>
      <span>{children}</span>
      {count !== undefined && count > 0 && <span className="nav-count">{count}</span>}
    </Link>
  );
}
