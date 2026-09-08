import { notFound } from 'next/navigation';
import { DrizzleCatalogAdminStore } from '@levelup/db';
import type { ComboDraft } from '@levelup/engine';
import { db } from '../../../../lib/db';
import { requireSession } from '../../../../lib/session';
import { ComboForm } from './combo-form';

export const dynamic = 'force-dynamic';

/** `/combos/nuevo` opens an empty form; any other key edits that combo. */
const NEW = 'nuevo';

const EMPTY: ComboDraft = {
  key: '',
  name: '',
  priceMxnCents: 0,
  advertisedDiamonds: 0,
  maxPerPlayer: null,
  recipe: [],
  active: false,
};

export default async function ComboEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ motivo?: string }>;
}) {
  await requireSession();
  const { key } = await params;
  const { motivo } = await searchParams;

  const store = new DrizzleCatalogAdminStore(db);
  const [campaigns, products] = await Promise.all([
    store.listCampaignOptions(),
    store.listAvailableProducts(),
  ]);

  const isNew = key === NEW;
  const existing = isNew ? null : await store.loadComboDraft(key);
  if (!isNew && !existing) notFound();

  if (campaigns.length === 0) {
    return (
      <>
        <h1>Nuevo combo</h1>
        <div className="alert warn">
          Primero crea una promoción. Los combos viven dentro de una promoción.
        </div>
        <a className="btn primary" href="/combos/promocion/nueva">
          Crear promoción
        </a>
      </>
    );
  }

  const draft: ComboDraft = existing ?? EMPTY;

  return (
    <>
      <a href="/combos" className="back">
        ← Combos
      </a>
      <h1>{isNew ? 'Nuevo combo' : draft.name}</h1>
      <p className="subtitle">
        El cliente ve un solo paquete. Por dentro pueden ser varias recargas.
      </p>

      {/* Set when someone tried to activate a combo that no longer passes —
          usually because the provider withdrew a denomination it depends on. */}
      {motivo === 'validacion' && (
        <div className="alert bad">
          No se pudo activar: la receta ya no cumple. Revisa los errores abajo.
        </div>
      )}

      <ComboForm
        draft={draft}
        campaignKey={
          existing
            ? (campaigns.find((c) => c.id === existing.campaignId)?.key ?? campaigns[0]!.key)
            : campaigns[0]!.key
        }
        campaigns={campaigns.map((c) => ({ key: c.key, name: c.name }))}
        available={products.map((p) => ({
          diamondsBase: p.diamondsBase,
          delivered: (p.diamondsBase * 110) / 100,
          active: p.active,
        }))}
        isNew={isNew}
      />
    </>
  );
}
