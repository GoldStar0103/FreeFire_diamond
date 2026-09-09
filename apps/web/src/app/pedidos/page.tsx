import type { Metadata } from 'next';
import { LookupForm } from './lookup-form';

export const metadata: Metadata = {
  title: 'Tus pedidos — LevelUp Store',
  description: 'Consulta el estado de tu recarga.',
};

export default function OrdersLookupPage() {
  return (
    <main className="page narrow">
      <h1 className="page-title">Tus pedidos</h1>
      <p className="page-sub">
        Consulta tu recarga con el número de pedido y tu ID de Free Fire.
      </p>

      <LookupForm />

      <div className="card">
        <h2 className="mini-title">¿No tienes el número?</h2>
        <p className="hint">
          Te lo mandamos al terminar tu compra. Empieza con <span className="mono">LU-</span> y
          se ve así: <span className="mono">LU-260915-AB12</span>.
        </p>
      </div>
    </main>
  );
}
