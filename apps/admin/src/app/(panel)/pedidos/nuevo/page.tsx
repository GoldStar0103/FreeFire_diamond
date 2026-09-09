import Link from 'next/link';
import { listCombosForAdmin } from '@levelup/db';
import { ACCEPTABLE_SHORTFALL_DIAMONDS } from '@levelup/engine';
import { db } from '../../../../lib/db';
import { requireSession } from '../../../../lib/session';
import { diamonds, mxn } from '../../../../lib/format';
import { NewOrderForm } from './new-order-form';

export const dynamic = 'force-dynamic';

export default async function NewOrderPage() {
  await requireSession();
  const combos = await listCombosForAdmin(db);

  // A combo that under-delivers cannot be sold through any door, including
  // this one. One that is merely switched off still can — that is the point.
  const sellable = combos.filter((c) => c.gap >= -ACCEPTABLE_SHORTFALL_DIAMONDS && c.callCount > 0);

  return (
    <>
      <Link href="/pedidos" className="back">
        ← Pedidos
      </Link>
      <h1>Nuevo pedido manual</h1>
      <p className="subtitle">
        Para las ventas que llegan por WhatsApp. Registras lo que compró el cliente y el
        sistema hace la recarga solo.
      </p>

      {sellable.length === 0 ? (
        <div className="card empty">
          No hay combos vendibles. Revisa el catálogo y la sincronización del proveedor.
        </div>
      ) : (
        <NewOrderForm
          combos={sellable.map((c) => ({
            key: c.key,
            label: `${c.name} (${diamonds(c.advertisedDiamonds)} 💎)`,
            price: mxn(c.priceMxnCents),
            campaignName: c.campaignName,
            active: c.active && c.campaignActive,
          }))}
        />
      )}
    </>
  );
}
