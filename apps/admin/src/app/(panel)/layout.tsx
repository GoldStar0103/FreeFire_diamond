import { listPendingApprovals } from '@levelup/db';
import { db } from '../../lib/db';
import { requireSession } from '../../lib/session';
import { logout } from '../login/actions';
import { NavLink } from './nav-link';

/**
 * Every panel route renders inside this, so the session check here is the
 * gate for the whole panel. See lib/session.ts for why this is not middleware.
 */
export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  // Badged in the nav so nobody has to remember to check the queue.
  const pending = await listPendingApprovals(db, 100);

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">LEVELUP STORE</div>
        <NavLink href="/">Inicio</NavLink>
        <NavLink href="/aprobaciones" count={pending.length}>
          Aprobaciones
        </NavLink>
        <NavLink href="/pedidos">Pedidos</NavLink>
        <NavLink href="/combos">Combos</NavLink>

        <div className="spacer" />
        <form action={logout}>
          <button className="btn sm" type="submit" style={{ width: '100%' }}>
            Salir
          </button>
        </form>
        <div style={{ color: 'var(--muted)', fontSize: 12, padding: '8px 10px 0' }}>
          {session.email}
        </div>
      </nav>

      <main className="main">{children}</main>
    </div>
  );
}
