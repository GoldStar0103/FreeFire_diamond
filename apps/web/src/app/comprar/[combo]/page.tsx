import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getStorefrontCombo } from '@levelup/db';
import { db } from '../../../lib/server';
import { diamonds, mxn } from '../../../lib/format';
import { Checkout } from './checkout';

export const dynamic = 'force-dynamic';

export default async function BuyPage({ params }: { params: Promise<{ combo: string }> }) {
  const { combo: comboKey } = await params;
  const combo = await getStorefrontCombo(db, comboKey);
  if (!combo) notFound();

  return (
    <main className="page narrow">
      <Link href="/" className="back">
        ← Volver
      </Link>

      <Checkout
        comboKey={combo.key}
        comboName={combo.name}
        price={mxn(combo.priceMxnCents)}
        diamonds={diamonds(combo.advertisedDiamonds)}
        bankDetails={{
          bank: process.env.PAY_BANK ?? 'BBVA',
          clabe: process.env.PAY_CLABE ?? '',
          holder: process.env.PAY_HOLDER ?? 'LEVELUP STORE',
          oxxo: process.env.PAY_OXXO ?? '',
        }}
      />
    </main>
  );
}
