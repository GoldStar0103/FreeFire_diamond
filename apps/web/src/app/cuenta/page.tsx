import type { Metadata } from 'next';
import { getCustomerSession } from '../../lib/customer-session.js';
import { CuentaForm } from './cuenta-form';

export const metadata: Metadata = {
  title: 'Mi LevelUp',
  description: 'Inicia sesión con tu WhatsApp para ver tu progreso.',
  alternates: { canonical: '/cuenta' },
};

// Same reasoning as every other dynamic page here: a session cookie read
// cannot be baked into a prerendered page.
export const dynamic = 'force-dynamic';

export default async function CuentaPage() {
  const session = await getCustomerSession();

  if (session) {
    // The full Mi LevelUp dashboard (Level Pass, Season, Vault, badges) is
    // built in a later phase — this page's job for now is proving the
    // account exists and the session round-trips correctly.
    return (
      <main className="page narrow">
        <h1 className="page-title">Mi LevelUp</h1>
        <p className="page-sub">Tu cuenta está lista. Muy pronto verás aquí tu progreso.</p>
      </main>
    );
  }

  return (
    <main className="page narrow">
      <h1 className="page-title">Mi LevelUp</h1>
      <p className="page-sub">Inicia sesión con tu WhatsApp para ver tu progreso, rachas y recompensas.</p>
      <CuentaForm />
    </main>
  );
}
