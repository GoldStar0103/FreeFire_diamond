import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readPurposeToken } from '../../../lib/auth';
import { PENDING_2FA_COOKIE, PENDING_2FA_PURPOSE } from '../pending-2fa';
import logo from '../../../assets/logo.webp';
import { VerifyForm } from './verify-form';

export const dynamic = 'force-dynamic';

/**
 * The second login step for an admin with 2FA enabled. Driven entirely by
 * whether the pending cookie is present and valid — not by anything in the
 * URL — so refreshing this page re-checks the same pending login instead of
 * resubmitting the password, and an expired/missing cookie sends the admin
 * back to start rather than showing a code box with nothing to verify.
 */
export default async function VerifyTotpPage() {
  const store = await cookies();
  const secret = process.env.ADMIN_SESSION_SECRET;
  const pending = secret
    ? readPurposeToken(store.get(PENDING_2FA_COOKIE)?.value, secret, PENDING_2FA_PURPOSE)
    : null;

  if (!pending) redirect('/login');

  return (
    <main className="login-page">
      <div className="card login-card">
        <div className="brand" style={{ padding: '0 0 18px' }}>
          <img src={logo.src} width={32} height={32} alt="" />
          <span>LEVELUP STORE</span>
        </div>
        <p className="hint" style={{ marginTop: 0 }}>
          Ingresa el código de 6 dígitos de tu app de autenticación.
        </p>
        <VerifyForm />
      </div>
    </main>
  );
}
