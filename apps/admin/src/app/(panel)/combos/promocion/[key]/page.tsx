import { eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { campaigns as campaignsTable } from '@levelup/db';
import { getDb } from '../../../../../lib/db';
import { requireSession } from '../../../../../lib/session';
import { CampaignForm } from './campaign-form';

export const dynamic = 'force-dynamic';

const NEW = 'nueva';

export default async function CampaignEditorPage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  await requireSession();
  const { key } = await params;
  const isNew = key === NEW;

  const [existing] = isNew
    ? []
    : await getDb().select().from(campaignsTable).where(eq(campaignsTable.key, key)).limit(1);

  if (!isNew && !existing) notFound();

  const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '');

  return (
    <>
      <a href="/combos" className="back">
        ← Combos
      </a>
      <h1>{isNew ? 'Nueva promoción' : existing!.name}</h1>
      <p className="subtitle">
        Una promoción agrupa varios combos y lleva el flyer que se publica en redes.
      </p>

      <CampaignForm
        isNew={isNew}
        initial={{
          key: existing?.key ?? '',
          name: existing?.name ?? '',
          badge: existing?.badge ?? '',
          permanent: existing?.permanent ?? false,
          active: existing?.active ?? false,
          startsAt: iso(existing?.startsAt ?? null),
          endsAt: iso(existing?.endsAt ?? null),
          sortOrder: existing?.sortOrder ?? 0,
          hasFlyer: Boolean(existing?.flyerAssetUrl),
        }}
      />
    </>
  );
}
