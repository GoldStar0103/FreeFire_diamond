/**
 * Combo authoring rules.
 *
 * The client rotates flyers every month and asked to do it without a developer:
 * "si cada cambio dependiera de un desarrollador, terminaría siendo un problema
 * operativo." This is what makes that safe — every rule that used to live in my
 * head is checked before anything reaches the storefront.
 *
 * The governing distinction: a draft can always be saved, but a combo can only
 * be ACTIVATED if it passes. Half-finished work is never lost, and a broken
 * combo is never on sale.
 */

import { ACCEPTABLE_SHORTFALL_DIAMONDS, checkRecipe } from '@levelup/shared/money';
import type { UsdTenK } from '@levelup/provider';

/** The maximum an order can reasonably take: 8 calls at ~1.5s pacing is ~12s. */
export const MAX_RECOMMENDED_CALLS = 8;

/** Below this, an FX move or a supplier price rise turns the combo unprofitable. */
export const THIN_MARGIN_PCT = 8;

export interface AvailableProduct {
  diamondsBase: number;
  costUsd: UsdTenK | null;
  active: boolean;
}

export interface ComboDraft {
  key: string;
  name: string;
  priceMxnCents: number;
  advertisedDiamonds: number;
  maxPerPlayer: number | null;
  /** Base denominations in call order. Repeats mean repeated calls. */
  recipe: number[];
  active: boolean;
}

export interface DraftIssue {
  code: string;
  message: string;
  field?: 'key' | 'name' | 'price' | 'advertised' | 'recipe' | 'maxPerPlayer';
}

export interface ComboDraftReview {
  /** True when the draft may be saved ACTIVE. A draft can always be saved inactive. */
  canActivate: boolean;
  delivered: number;
  gap: number;
  /** Short of the flyer, but inside the client's rounding tolerance. */
  roundedDown: boolean;
  callCount: number;
  costUsd: number | null;
  costMxnCents: number | null;
  marginMxnCents: number | null;
  marginPct: number | null;
  errors: DraftIssue[];
  warnings: DraftIssue[];
}

const KEY_PATTERN = /^[a-z0-9_]{3,40}$/;

/**
 * Check a combo before it can go on sale.
 *
 * Errors block activation; warnings are shown and can be overridden by the
 * person doing the work, who knows things the system does not.
 */
export function reviewComboDraft(
  draft: ComboDraft,
  products: readonly AvailableProduct[],
  fxUsdMxn: number,
): ComboDraftReview {
  const errors: DraftIssue[] = [];
  const warnings: DraftIssue[] = [];

  if (!KEY_PATTERN.test(draft.key)) {
    errors.push({
      code: 'BAD_KEY',
      field: 'key',
      message: 'La clave debe tener de 3 a 40 caracteres: minúsculas, números y guion bajo.',
    });
  }
  if (draft.name.trim().length < 3) {
    errors.push({ code: 'BAD_NAME', field: 'name', message: 'Ponle un nombre al combo.' });
  }
  if (draft.priceMxnCents <= 0) {
    errors.push({ code: 'BAD_PRICE', field: 'price', message: 'El precio debe ser mayor a cero.' });
  }
  if (draft.advertisedDiamonds <= 0) {
    errors.push({
      code: 'BAD_ADVERTISED',
      field: 'advertised',
      message: 'Indica cuántos diamantes anuncia el flyer.',
    });
  }
  if (draft.maxPerPlayer !== null && draft.maxPerPlayer < 1) {
    errors.push({
      code: 'BAD_LIMIT',
      field: 'maxPerPlayer',
      message: 'El límite por jugador debe ser al menos 1, o vacío para sin límite.',
    });
  }

  if (draft.recipe.length === 0) {
    errors.push({
      code: 'EMPTY_RECIPE',
      field: 'recipe',
      message: 'Agrega al menos una recarga a la receta.',
    });
    // Nothing further can be computed without a recipe.
    return {
      canActivate: false,
      delivered: 0,
      gap: -draft.advertisedDiamonds,
      roundedDown: false,
      callCount: 0,
      costUsd: null,
      costMxnCents: null,
      marginMxnCents: null,
      marginPct: null,
      errors,
      warnings,
    };
  }

  const byDenomination = new Map(products.map((p) => [p.diamondsBase, p]));

  const unknown = draft.recipe.filter((d) => !byDenomination.has(d));
  if (unknown.length > 0) {
    errors.push({
      code: 'UNKNOWN_PRODUCT',
      field: 'recipe',
      message: `El proveedor no tiene recargas de: ${[...new Set(unknown)].join(', ')} 💎.`,
    });
  }

  const inactive = draft.recipe.filter((d) => byDenomination.get(d)?.active === false);
  if (inactive.length > 0) {
    errors.push({
      code: 'INACTIVE_PRODUCT',
      field: 'recipe',
      message: `Estas recargas ya no están disponibles: ${[...new Set(inactive)].join(', ')} 💎.`,
    });
  }

  const check = checkRecipe(draft.advertisedDiamonds, draft.recipe);
  if (!check.ok) {
    errors.push({
      code: 'UNDER_DELIVERS',
      field: 'advertised',
      message:
        `La receta entrega ${check.delivered.toLocaleString('es-MX')} 💎 y el flyer anuncia ` +
        `${draft.advertisedDiamonds.toLocaleString('es-MX')}. Faltan ${Math.abs(check.gap)}. ` +
        `Ajusta el número del flyer o agrega otra recarga.`,
    });
  } else if (check.withinTolerance) {
    warnings.push({
      code: 'ROUNDED_DOWN',
      field: 'advertised',
      message: `Entrega ${Math.abs(check.gap)} 💎 menos de lo anunciado (redondeo, aceptable).`,
    });
  }

  if (draft.recipe.length > MAX_RECOMMENDED_CALLS) {
    warnings.push({
      code: 'MANY_CALLS',
      field: 'recipe',
      message: `${draft.recipe.length} recargas hacen la entrega más lenta y más frágil.`,
    });
  }

  // Margin needs every product costed; a partial sum would mislead.
  const costs = draft.recipe.map((d) => byDenomination.get(d)?.costUsd ?? null);
  const allCosted = costs.every((c): c is UsdTenK => c !== null);

  let costUsd: number | null = null;
  let costMxnCents: number | null = null;
  let marginMxnCents: number | null = null;
  let marginPct: number | null = null;

  if (allCosted && fxUsdMxn > 0) {
    const totalTenK = costs.reduce<number>((sum, c) => sum + c, 0);
    costUsd = totalTenK / 10_000;
    costMxnCents = Math.round(costUsd * fxUsdMxn * 100);
    marginMxnCents = draft.priceMxnCents - costMxnCents;
    marginPct = draft.priceMxnCents > 0 ? (marginMxnCents / draft.priceMxnCents) * 100 : 0;

    if (marginMxnCents < 0) {
      // Not an error: the $10 Mega Oferta loses money deliberately, as customer
      // acquisition. But nobody should create one by accident.
      warnings.push({
        code: 'NEGATIVE_MARGIN',
        field: 'price',
        message:
          `Este combo pierde $${(Math.abs(marginMxnCents) / 100).toFixed(2)} por venta. ` +
          `Solo tiene sentido como oferta de enganche.`,
      });
    } else if (marginPct < THIN_MARGIN_PCT) {
      warnings.push({
        code: 'THIN_MARGIN',
        field: 'price',
        message: `Margen de ${marginPct.toFixed(1)}%. Un cambio del dólar puede dejarlo en pérdida.`,
      });
    }
  } else if (!allCosted) {
    warnings.push({
      code: 'NO_COST',
      field: 'recipe',
      message: 'Falta el costo de alguna recarga. Corre la sincronización del catálogo.',
    });
  }

  return {
    canActivate: errors.length === 0,
    delivered: check.delivered,
    gap: check.gap,
    roundedDown: check.withinTolerance,
    callCount: draft.recipe.length,
    costUsd,
    costMxnCents,
    marginMxnCents,
    marginPct,
    errors,
    warnings,
  };
}

export interface CampaignDraft {
  key: string;
  name: string;
  badge: string | null;
  permanent: boolean;
  active: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
}

export function reviewCampaignDraft(draft: CampaignDraft): DraftIssue[] {
  const errors: DraftIssue[] = [];

  if (!KEY_PATTERN.test(draft.key)) {
    errors.push({
      code: 'BAD_KEY',
      field: 'key',
      message: 'La clave debe tener de 3 a 40 caracteres: minúsculas, números y guion bajo.',
    });
  }
  if (draft.name.trim().length < 3) {
    errors.push({ code: 'BAD_NAME', field: 'name', message: 'Ponle un nombre a la promoción.' });
  }
  if (draft.startsAt && draft.endsAt && draft.startsAt >= draft.endsAt) {
    errors.push({
      code: 'BAD_WINDOW',
      message: 'La fecha de inicio debe ser antes de la de fin.',
    });
  }

  return errors;
}

/** Re-exported so the admin UI can explain the rule it is enforcing. */
export { ACCEPTABLE_SHORTFALL_DIAMONDS };
