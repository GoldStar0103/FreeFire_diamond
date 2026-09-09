import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getStorefrontCombo } from '@levelup/db';
import { getDb } from '../../../lib/server';
import { diamonds, mxn } from '../../../lib/format';
import { Checkout } from './checkout';

export const dynamic = 'force-dynamic';

/**
 * Titles and descriptions per offer, matching the generated preview card next
 * door. A link shared into a group should say what it is in the tab, in the
 * card and in search results — not "LevelUp Store" three times.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ combo: string }>;
}): Promise<Metadata> {
  const { combo: comboKey } = await params;
  const combo = await getStorefrontCombo(getDb(), comboKey);

  if (!combo) return { title: 'Paquete no disponible' };

  const title = `${combo.name} — ${diamonds(combo.advertisedDiamonds)} diamantes`;
  const description =
    `${diamonds(combo.advertisedDiamonds)} diamantes de Free Fire por ` +
    `${mxn(combo.priceMxnCents)}. Entrega automática a tu cuenta, sin contraseñas.`;

  return {
    title,
    description,
    alternates: { canonical: `/comprar/${combo.key}` },
    openGraph: {
      type: 'website',
      title,
      description,
      url: `/comprar/${combo.key}`,
    },
    twitter: { card: 'summary_large_image', title, description },
  };
}

export default async function BuyPage({ params }: { params: Promise<{ combo: string }> }) {
  const { combo: comboKey } = await params;
  const combo = await getStorefrontCombo(getDb(), comboKey);
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
