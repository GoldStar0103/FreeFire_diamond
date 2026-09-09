'use client';

import { useActionState } from 'react';
import { saveSettings, type SettingsFormState } from './actions';

interface Props {
  initial: {
    bank: string;
    clabe: string;
    holder: string;
    oxxo: string;
    fxRate: string;
  };
  /** True when nothing is configured yet and the storefront cannot take money. */
  missing: boolean;
}

export function SettingsForm({ initial, missing }: Props) {
  const [state, action, saving] = useActionState<SettingsFormState, FormData>(saveSettings, {});

  return (
    <form action={action}>
      {missing && (
        <div className="alert bad">
          <strong>La tienda no puede recibir pagos ahora mismo.</strong>
          <p style={{ margin: '6px 0 0' }}>
            Nadie ha configurado la cuenta. Los clientes ven un aviso para escribirte por WhatsApp
            en lugar de los datos de pago. En cuanto guardes aquí, la tienda vuelve a funcionar.
          </p>
        </div>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Datos para recibir pagos</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Esto es exactamente lo que ve el cliente antes de transferirte.
        </p>

        <div className="row">
          <label className="field grow">
            <span>Banco</span>
            <input name="bank" defaultValue={initial.bank} placeholder="BBVA" required />
          </label>
          <label className="field grow">
            <span>Titular de la cuenta</span>
            <input
              name="holder"
              defaultValue={initial.holder}
              placeholder="Como aparece en tu banco"
              required
            />
          </label>
        </div>

        <label className="field">
          <span>CLABE (18 dígitos)</span>
          <input
            name="clabe"
            defaultValue={initial.clabe}
            inputMode="numeric"
            className="mono"
            placeholder="012 180 01234567890 1"
            required
          />
        </label>
        <p className="hint">
          Verificamos el dígito de control antes de guardar, así que una CLABE mal copiada se
          detecta aquí y no cuando un cliente intente pagarte.
        </p>

        <label className="field">
          <span>Número para depósito en OXXO (opcional)</span>
          <input
            name="oxxo"
            defaultValue={initial.oxxo}
            inputMode="numeric"
            className="mono"
            placeholder="Déjalo vacío si no lo usas"
          />
        </label>
        <p className="hint">Si lo dejas vacío, esa línea no aparece en la tienda.</p>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Tipo de cambio</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Pesos por dólar. Sólo se usa para mostrarte costos y ganancias en este panel —{' '}
          <strong>no cambia el precio que paga el cliente.</strong>
        </p>
        <label className="field" style={{ maxWidth: 180 }}>
          <span>MXN por USD</span>
          <input name="fxRate" defaultValue={initial.fxRate} inputMode="decimal" required />
        </label>
      </div>

      {state.issues?.map((issue) => (
        <div className="alert bad" key={issue}>
          {issue}
        </div>
      ))}
      {state.saved && <div className="alert ok">Guardado. La tienda ya usa estos datos.</div>}

      <div className="row">
        <div className="spacer" />
        <button className="btn primary" type="submit" disabled={saving}>
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
      </div>
    </form>
  );
}
