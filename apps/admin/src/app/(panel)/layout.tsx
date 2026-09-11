import { listPendingApprovals } from '@levelup/db';
import { getDb } from '../../lib/db';
import { requireSession } from '../../lib/session';
import { logout } from '../login/actions';
import { NavLink } from './nav-link';
// Through the bundler, not `public/`, which the standalone Docker image does
// not copy. See the storefront's home page for the longer version.
import logo from '../../assets/logo.webp';

/**
 * Every panel route renders inside this, so the session check here is the
 * gate for the whole panel. See lib/session.ts for why this is not middleware.
 */
export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  // Badged in the nav so nobody has to remember to check the queue.
  const pending = await listPendingApprovals(getDb(), 100);

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">
          <img src={logo.src} width={32} height={32} alt="" />
          <span>LEVELUP STORE</span>
        </div>
        <NavLink href="/">Inicio</NavLink>
        <NavLink href="/aprobaciones" count={pending.length}>
          Aprobaciones
        </NavLink>
        <NavLink href="/pedidos">Pedidos</NavLink>
        <NavLink href="/combos">Combos</NavLink>
        <NavLink href="/testimonios">Testimonios</NavLink>
        <NavLink href="/ajustes">Ajustes</NavLink>

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
