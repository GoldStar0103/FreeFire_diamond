'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { campaigns, DrizzleCatalogAdminStore } from '@levelup/db';
import {
  reviewCampaignDraft,
  reviewComboDraft,
  type ComboDraftReview,
  type DraftIssue,
} from '@levelup/engine';
import { db } from '../../../lib/db';
import { storeFlyer } from '../../../lib/flyers';
import { requireSession } from '../../../lib/session';

export interface ComboFormState {
  review?: ComboDraftReview;
  error?: string;
  ok?: string;
}

export interface CampaignFormState {
  errors?: DraftIssue[];
  error?: string;
  ok?: string;
}

const store = () => new DrizzleCatalogAdminStore(db);

async function fxRate(): Promise<number> {
  const rate = Number(process.env.FX_USD_MXN ?? 18.5);
  return Number.isFinite(rate) && rate > 0 ? rate : 18.5;
}

/** Recipe arrives as a comma-separated list of denominations, in call order. */
function parseRecipe(raw: string): number[] {
  return raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function readComboForm(formData: FormData) {
  const pesos = Number(formData.get('priceMxn'));
  const cap = String(formData.get('maxPerPlayer') ?? '').trim();

  return {
    key: String(formData.get('key') ?? '').trim().toLowerCase(),
    name: String(formData.get('name') ?? ''),
    priceMxnCents: Number.isFinite(pesos) ? Math.round(pesos * 100) : 0,
    advertisedDiamonds: Number(formData.get('advertisedDiamonds')) || 0,
    maxPerPlayer: cap === '' ? null : Number(cap),
    recipe: parseRecipe(String(formData.get('recipe') ?? '')),
    active: formData.get('active') === 'true',
  };
}

/**
 * Check a draft without saving, so the form can show the maths as it is typed.
 *
 * Runs on the server because it needs live provider costs — the recipe builder
 * would otherwise be guessing at margins.
 */
export async function previewCombo(
  _prev: ComboFormState,
  formData: FormData,
): Promise<ComboFormState> {
  await requireSession();
  const products = await store().listAvailableProducts();
  return { review: reviewComboDraft(readComboForm(formData), products, await fxRate()) };
}

export async function saveCombo(
  _prev: ComboFormState,
  formData: FormData,
): Promise<ComboFormState> {
  const session = await requireSession();

  const draft = readComboForm(formData);
  const campaignKey = String(formData.get('campaignKey') ?? '');

  const products = await store().listAvailableProducts();
  const review = reviewComboDraft(draft, products, await fxRate());

  // A draft can always be saved; only activation is gated. Half-finished work
  // is never lost, and a broken combo never reaches the storefront.
  if (draft.active && !review.canActivate) {
    return {
      review,
      error: 'No se puede activar así. Corrige los errores o guárdalo apagado como borrador.',
    };
  }

  const [campaign] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(eq(campaigns.key, campaignKey))
    .limit(1);

  if (!campaign) return { review, error: 'Selecciona una promoción válida.' };

  const existing = await store().loadComboDraft(draft.key);
  const sortOrder = existing?.sortOrder ?? (await store().nextComboSortOrder(campaign.id));

  try {
    await store().saveCombo(draft, {
      campaignId: campaign.id,
      sortOrder,
      adminUserId: session.adminUserId,
    });
  } catch (err) {
    console.error('[combos] save failed', err);
    return { review, error: 'No se pudo guardar. Revisa que las recargas sigan disponibles.' };
  }

  revalidatePath('/combos');
  redirect('/combos');
}

export async function toggleCombo(formData: FormData): Promise<void> {
  const session = await requireSession();
  const comboKey = String(formData.get('comboKey') ?? '');
  const next = formData.get('active') === 'true';

  // Re-validated on the way on: a combo can drift out of compliance after it
  // was saved, if the provider withdraws a denomination it depends on.
  if (next) {
    const draft = await store().loadComboDraft(comboKey);
    if (!draft) return;

    const products = await store().listAvailableProducts();
    if (!reviewComboDraft({ ...draft, active: true }, products, await fxRate()).canActivate) {
      redirect(`/combos/${encodeURIComponent(comboKey)}?motivo=validacion`);
    }
  }

  await store().setComboActive(comboKey, next, session.adminUserId);
  revalidatePath('/combos');
}

export async function saveCampaign(
  _prev: CampaignFormState,
  formData: FormData,
): Promise<CampaignFormState> {
  const session = await requireSession();

  const parseDate = (value: FormDataEntryValue | null): Date | null => {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  };

  const draft = {
    key: String(formData.get('key') ?? '').trim().toLowerCase(),
    name: String(formData.get('name') ?? ''),
    badge: String(formData.get('badge') ?? '').trim() || null,
    permanent: formData.get('permanent') === 'true',
    active: formData.get('active') === 'true',
    startsAt: parseDate(formData.get('startsAt')),
    endsAt: parseDate(formData.get('endsAt')),
  };

  const errors = reviewCampaignDraft(draft);
  if (errors.length > 0) return { errors };

  // Omitting the flyer leaves the existing one alone, so editing dates does not
  // wipe the image.
  let flyerAssetUrl: string | undefined;
  const flyer = formData.get('flyer');
  if (flyer instanceof File && flyer.size > 0) {
    const stored = await storeFlyer(draft.key, new Uint8Array(await flyer.arrayBuffer()));
    if (!stored.ok) return { error: stored.rejection.message };
    flyerAssetUrl = stored.key;
  }

  await store().saveCampaign(draft, {
    sortOrder: Number(formData.get('sortOrder')) || 0,
    ...(flyerAssetUrl === undefined ? {} : { flyerAssetUrl }),
    adminUserId: session.adminUserId,
  });

  revalidatePath('/combos');
  redirect('/combos');
}

export async function retireCampaign(formData: FormData): Promise<void> {
  const session = await requireSession();
  const campaignKey = String(formData.get('campaignKey') ?? '');
  if (!campaignKey) return;

  await store().retireCampaign(campaignKey, session.adminUserId);
  revalidatePath('/combos');
}
