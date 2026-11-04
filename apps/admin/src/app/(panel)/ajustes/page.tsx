import { eq } from 'drizzle-orm';
import {
  adminUsers,
  DEFAULT_FX_RATE,
  getActiveProvider,
  getEmergencyMode,
  getFxRate,
  getPaymentDetails,
  getPaymentMethodsEnabled,
} from '@levelup/db';
import type { ProviderName } from '@levelup/provider';
import { getDb } from '../../../lib/db';
import { requireSession } from '../../../lib/session';
import { setActiveProviderAction, setEmergencyModeAction } from './actions';
import { SettingsForm } from './settings-form';
import { TwoFactorForm } from './two-factor-form';

const PROVIDER_LABEL: Record<ProviderName, string> = {
  recargas_america: 'RecargasAmérica',
  central_one: 'Central One',
};

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

  const [payTo, fxRate, methodsEnabled, emergencyMode, activeProvider, [admin]] = await Promise.all([
    getPaymentDetails(getDb()),
    getFxRate(getDb()),
    getPaymentMethodsEnabled(getDb()),
    getEmergencyMode(getDb()),
    getActiveProvider(getDb()),
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
        methodsEnabled={methodsEnabled}
        initial={{
          bank: payTo?.bank ?? '',
          clabe: payTo?.clabe ?? '',
          holder: payTo?.holder ?? '',
          oxxo: payTo?.oxxo ?? '',
          cardNumber: payTo?.cardNumber ?? '',
          fxRate: String(fxRate || DEFAULT_FX_RATE),
        }}
      />

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Proveedor activo</h2>
        <p className="subtitle">
          Quién surte los pedidos nuevos ahora mismo. Cambiar aquí mueve las recetas de los
          combos y los pedidos aún no enviados al otro proveedor — lo mismo que hace el sistema
          solo cuando detecta que {PROVIDER_LABEL.recargas_america} falla. Úsalo también para
          volver a {PROVIDER_LABEL.recargas_america} una vez que confirmes que ya funciona de
          nuevo (eso nunca pasa solo).
        </p>
        <div className="row">
          <span className="badge ok">{PROVIDER_LABEL[activeProvider.provider]}</span>
          <div className="spacer" />
          <form action={setActiveProviderAction}>
            <input
              type="hidden"
              name="provider"
              value={activeProvider.provider === 'recargas_america' ? 'central_one' : 'recargas_america'}
            />
            <button className="btn" type="submit">
              Cambiar a{' '}
              {activeProvider.provider === 'recargas_america'
                ? PROVIDER_LABEL.central_one
                : PROVIDER_LABEL.recargas_america}
            </button>
          </form>
        </div>
      </div>

      <div className="card" style={emergencyMode.enabled ? { borderColor: 'var(--bad)' } : undefined}>
        <h2 style={{ marginTop: 0 }}>Modo de emergencia</h2>
        <p className="subtitle">
          Mientras está activo, los pedidos nuevos NO se envían automáticamente a ningún
          proveedor — quedan en &quot;Requieren revisión&quot; para que los entregues tú a mano
          (por ejemplo con el proveedor de emergencia) y los marques como entregados ahí. Los
          clientes siguen comprando normal; esto solo cambia cómo se entregan por detrás.
          Desactívalo en cuanto el proveedor automático vuelva a funcionar.
        </p>
        <form action={setEmergencyModeAction}>
          <input type="hidden" name="enabled" value={(!emergencyMode.enabled).toString()} />
          <div className="row">
            <span className={`badge ${emergencyMode.enabled ? 'bad' : 'ok'}`}>
              {emergencyMode.enabled ? 'ACTIVO' : 'Apagado'}
            </span>
            <div className="spacer" />
            <button className={`btn ${emergencyMode.enabled ? '' : 'danger'}`} type="submit">
              {emergencyMode.enabled ? 'Desactivar modo de emergencia' : 'Activar modo de emergencia'}
            </button>
          </div>
        </form>
      </div>

      <TwoFactorForm enabled={admin?.totpSecret != null} />
    </>
  );
}
