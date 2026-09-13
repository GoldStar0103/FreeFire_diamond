import { eq } from 'drizzle-orm';
import { adminUsers, DEFAULT_FX_RATE, getFxRate, getPaymentDetails } from '@levelup/db';
import { getDb } from '../../../lib/db';
import { requireSession } from '../../../lib/session';
import { SettingsForm } from './settings-form';
import { TwoFactorForm } from './two-factor-form';

export const dynamic = 'force-dynamic';

/**
 * The settings the owner actually needs to change without a developer.
 *
 * Bank accounts change, and for a small Mexican merchant one occasionally gets
 * frozen. When that happens the storefront is telling every customer to send
 * money to an account that no longer works, and the fix should take thirty
 * seconds in this panel rather than a redeploy.
 */
export default async function SettingsPage() {
  const session = await requireSession();

  const [payTo, fxRate, [admin]] = await Promise.all([
    getPaymentDetails(getDb()),
    getFxRate(getDb()),
    getDb()
      .select({ totpSecret: adminUsers.totpSecret })
      .from(adminUsers)
      .where(eq(adminUsers.id, session.adminUserId))
      .limit(1),
  ]);

  return (
    <>
      <h1 style={{ marginBottom: 0 }}>Ajustes</h1>
      <p className="subtitle">Datos de pago y tipo de cambio.</p>

      <SettingsForm
        missing={payTo === null}
        initial={{
          bank: payTo?.bank ?? '',
          clabe: payTo?.clabe ?? '',
          holder: payTo?.holder ?? '',
          oxxo: payTo?.oxxo ?? '',
          cardNumber: payTo?.cardNumber ?? '',
          fxRate: String(fxRate || DEFAULT_FX_RATE),
        }}
      />

      <TwoFactorForm enabled={admin?.totpSecret != null} />
    </>
  );
}
