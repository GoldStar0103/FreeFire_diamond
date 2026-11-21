'use server';

import { revalidatePath } from 'next/cache';
import { checkRecipe } from '@levelup/shared/money';
import { DrizzleGiveawayAdminStore, mexicoCityDateTimeToUtc, type CreateGiveawayInput } from '@levelup/db';
import { getDb } from '../../../lib/db';
import { requireSession } from '../../../lib/session';

export interface CreateGiveawayFormState {
  issues?: string[];
  created?: boolean;
}

const SCHEDULE_TYPES = ['daily', 'weekly', 'monthly', 'flash'] as const;
const PRIZE_TYPES = ['manual', 'diamonds'] as const;

/**
 * Pesos as typed by a human -> integer centavos. Same parsing rule as
 * `contabilidad/actions.ts`'s `parsePesos` — accepts "750", "750.50",
 * refuses anything else rather than guessing.
 */
function parsePesos(raw: string): number | null {
  const cleaned = raw.replace(/[\s,$]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

/** A server action is a public endpoint; the panel layout's gate does not cover it. */
export async function createGiveawayAction(
  _prev: CreateGiveawayFormState,
  formData: FormData,
): Promise<CreateGiveawayFormState> {
  const session = await requireSession();

  const issues: string[] = [];
  const title = String(formData.get('title') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim();
  const prizeDescription = String(formData.get('prizeDescription') ?? '').trim();
  const prizeValueRaw = String(formData.get('prizeValue') ?? '').trim();
  const prizeValueCents = prizeValueRaw ? parsePesos(prizeValueRaw) : null;
  const entryCostTickets = Number(formData.get('entryCostTickets'));
  const minEntries = Number(formData.get('minEntries'));
  const scheduleType = String(formData.get('scheduleType') ?? '');
  const opensAt = mexicoCityDateTimeToUtc(String(formData.get('opensAt') ?? ''));
  const closesAt = mexicoCityDateTimeToUtc(String(formData.get('closesAt') ?? ''));
  const maxEntriesPerPlayerRaw = String(formData.get('maxEntriesPerPlayer') ?? '').trim();
  const maxParticipantsRaw = String(formData.get('maxParticipants') ?? '').trim();
  const maxEntriesPerPlayer = maxEntriesPerPlayerRaw ? Number(maxEntriesPerPlayerRaw) : null;
  const maxParticipants = maxParticipantsRaw ? Number(maxParticipantsRaw) : null;
  const winnerCount = Number(formData.get('winnerCount'));
  const prizeType = String(formData.get('prizeType') ?? 'manual');
  const prizeDiamondsRaw = String(formData.get('prizeDiamonds') ?? '').trim();
  const prizeDiamonds = prizeDiamondsRaw ? Number(prizeDiamondsRaw) : null;
  const recipeDenominations = String(formData.get('prizeRecipe') ?? '')
    .split(',')
    .filter((d) => d !== '')
    .map(Number);

  if (!title) issues.push('Falta el título.');
  if (!description) issues.push('Falta la descripción.');
  if (!prizeDescription) issues.push('Falta la descripción del premio.');
  if (prizeValueRaw && prizeValueCents === null) {
    issues.push('El valor del premio no es válido — usa un número como 750.00.');
  }
  if (!Number.isFinite(entryCostTickets) || entryCostTickets < 1) {
    issues.push('El costo por entrada debe ser al menos 1 ticket.');
  }
  if (!Number.isFinite(minEntries) || minEntries < 0) {
    issues.push('El mínimo de entradas no puede ser negativo.');
  }
  if (maxEntriesPerPlayer !== null && (!Number.isFinite(maxEntriesPerPlayer) || maxEntriesPerPlayer < 1)) {
    issues.push('El máximo de entradas por jugador debe ser al menos 1.');
  }
  if (maxParticipants !== null && (!Number.isFinite(maxParticipants) || maxParticipants < 1)) {
    issues.push('El máximo de participantes debe ser al menos 1.');
  }
  if (!Number.isFinite(winnerCount) || winnerCount < 1) {
    issues.push('El número de ganadores debe ser al menos 1.');
  }
  if (!PRIZE_TYPES.includes(prizeType as (typeof PRIZE_TYPES)[number])) {
    issues.push('Elige un tipo de premio.');
  }
  if (!SCHEDULE_TYPES.includes(scheduleType as (typeof SCHEDULE_TYPES)[number])) {
    issues.push('Elige un tipo de sorteo.');
  }
  if (!opensAt) issues.push('La fecha de apertura no es válida.');
  if (!closesAt) issues.push('La fecha de cierre no es válida.');
  if (opensAt && closesAt && opensAt >= closesAt) issues.push('El cierre debe ser después de la apertura.');

  let prizeRecipe: { baseProductId: string; diamondsBase: number }[] | null = null;
  if (prizeType === 'diamonds') {
    if (!Number.isInteger(prizeDiamonds) || (prizeDiamonds ?? 0) <= 0) {
      issues.push('Los diamantes del premio deben ser un entero positivo.');
    }
    if (recipeDenominations.length === 0) {
      issues.push('Debe tener al menos una recarga en la receta de entrega del premio.');
    } else if (prizeDiamonds != null && prizeDiamonds > 0) {
      const check = checkRecipe(prizeDiamonds, recipeDenominations);
      if (!check.ok) {
        issues.push(`La receta entrega ${check.delivered} 💎 pero el premio promete ${prizeDiamonds}.`);
      }
    }
  }

  if (issues.length > 0 || !opensAt || !closesAt) return { issues };

  if (prizeType === 'diamonds') {
    try {
      prizeRecipe = await new DrizzleGiveawayAdminStore(getDb()).resolveGiveawayPrizeRecipe(recipeDenominations);
    } catch (err) {
      return { issues: [String(err instanceof Error ? err.message : err)] };
    }
  }

  const input: CreateGiveawayInput = {
    title,
    description,
    prizeDescription,
    prizeValueCents,
    entryCostTickets: Math.trunc(entryCostTickets),
    scheduleType: scheduleType as CreateGiveawayInput['scheduleType'],
    minEntries: Math.trunc(minEntries),
    maxEntriesPerPlayer: maxEntriesPerPlayer !== null ? Math.trunc(maxEntriesPerPlayer) : null,
    maxParticipants: maxParticipants !== null ? Math.trunc(maxParticipants) : null,
    winnerCount: Math.trunc(winnerCount),
    prizeType: prizeType as CreateGiveawayInput['prizeType'],
    prizeDiamonds: prizeType === 'diamonds' ? Math.trunc(prizeDiamonds!) : null,
    prizeRecipe,
    opensAt,
    closesAt,
  };

  await new DrizzleGiveawayAdminStore(getDb()).create(input, session.adminUserId);
  revalidatePath('/sorteos');

  return { created: true };
}

export async function publishGiveawayAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const id = String(formData.get('id') ?? '');

  await new DrizzleGiveawayAdminStore(getDb()).publish(id, session.adminUserId);

  revalidatePath('/sorteos');
  revalidatePath(`/sorteos/${id}`);
}

export interface CancelGiveawayState {
  ok?: string;
  error?: string;
}

/** Any state before `drawn` — refunds every entrant's tickets, same path the below-minimum auto-cancel uses. */
export async function cancelGiveawayAction(
  _prev: CancelGiveawayState,
  formData: FormData,
): Promise<CancelGiveawayState> {
  const session = await requireSession();
  const id = String(formData.get('id') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  if (!reason) return { error: 'Escribe un motivo.' };

  const cancelled = await new DrizzleGiveawayAdminStore(getDb()).cancel(id, session.adminUserId, reason);
  if (!cancelled) return { error: 'Ya no se puede cancelar — ya se sorteó o ya estaba cancelado.' };

  revalidatePath('/sorteos');
  revalidatePath(`/sorteos/${id}`);
  return { ok: 'Sorteo cancelado. Se devolvieron los tickets a quienes participaron.' };
}

export interface DrawWinnerState {
  ok?: string;
  error?: string;
}

const DRAW_FAILURE_LABEL: Record<'not_found' | 'wrong_status' | 'no_entries' | 'prize_value_required', string> = {
  not_found: 'No se encontró el sorteo.',
  wrong_status: 'Este sorteo todavía no está listo para sortear.',
  no_entries: 'Nadie participó en este sorteo.',
  prize_value_required: 'Antes define el valor del premio en MXN — se usa para registrar el gasto en Contabilidad.',
};

/** Admin-triggered only — the worker closes a giveaway for draw, but never picks a winner itself. Draws every slot (`winnerCount`) in one call. */
export async function drawWinnersAction(_prev: DrawWinnerState, formData: FormData): Promise<DrawWinnerState> {
  const session = await requireSession();
  const id = String(formData.get('id') ?? '');

  const result = await new DrizzleGiveawayAdminStore(getDb()).drawWinners(id, session.adminUserId);
  if (!result.ok) return { error: DRAW_FAILURE_LABEL[result.reason] };

  revalidatePath('/sorteos');
  revalidatePath(`/sorteos/${id}`);
  return { ok: result.winnerCount === 1 ? '1 ganador sorteado.' : `${result.winnerCount} ganadores sorteados.` };
}

export interface SetPrizeValueState {
  ok?: string;
  error?: string;
}

export async function setPrizeValueAction(
  _prev: SetPrizeValueState,
  formData: FormData,
): Promise<SetPrizeValueState> {
  const session = await requireSession();
  const id = String(formData.get('id') ?? '');
  const prizeValueCents = parsePesos(String(formData.get('prizeValue') ?? '').trim());
  if (prizeValueCents === null) return { error: 'El valor del premio no es válido — usa un número como 750.00.' };

  const updated = await new DrizzleGiveawayAdminStore(getDb()).setPrizeValueCents(
    id,
    prizeValueCents,
    session.adminUserId,
  );
  if (!updated) return { error: 'Ya no se puede editar — el premio ya fue entregado.' };

  revalidatePath('/sorteos');
  revalidatePath(`/sorteos/${id}`);
  return { ok: 'Valor del premio guardado.' };
}

export interface MarkDeliveredState {
  ok?: string;
  error?: string;
}

const DELIVER_FAILURE_LABEL: Record<'not_found' | 'already_delivered', string> = {
  not_found: 'No se encontró ese ganador.',
  already_delivered: 'Ya estaba marcado como entregado.',
};

/** Manual confirmation for ONE winner of a `prizeType = 'manual'` giveaway — `diamonds`-type winners deliver automatically, never through this. */
export async function markWinnerDeliveredAction(
  _prev: MarkDeliveredState,
  formData: FormData,
): Promise<MarkDeliveredState> {
  const session = await requireSession();
  const giveawayId = String(formData.get('giveawayId') ?? '');
  const winnerId = String(formData.get('winnerId') ?? '');

  const result = await new DrizzleGiveawayAdminStore(getDb()).markWinnerDelivered(
    giveawayId,
    winnerId,
    session.adminUserId,
  );
  if (!result.ok) return { error: DELIVER_FAILURE_LABEL[result.reason] };

  revalidatePath('/sorteos');
  revalidatePath(`/sorteos/${giveawayId}`);
  return { ok: 'Premio marcado como entregado. Se registró el gasto en Contabilidad.' };
}
