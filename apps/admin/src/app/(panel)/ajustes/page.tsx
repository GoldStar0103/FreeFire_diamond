import { DEFAULT_FX_RATE, getFxRate, getPaymentDetails } from '@levelup/db';
import { getDb } from '../../../lib/db';
import { requireSession } from '../../../lib/session';
import { SettingsForm } from './settings-form';

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
  await requireSession();

  const [payTo, fxRate] = await Promise.all([getPaymentDetails(getDb()), getFxRate(getDb())]);

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
          fxRate: String(fxRate || DEFAULT_FX_RATE),
        }}
      />
    </>
  );
}
