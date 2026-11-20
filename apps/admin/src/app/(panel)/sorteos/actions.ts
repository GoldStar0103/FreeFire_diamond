'use server';

import { revalidatePath } from 'next/cache';
import { DrizzleGiveawayAdminStore, mexicoCityDateTimeToUtc, type CreateGiveawayInput } from '@levelup/db';
import { getDb } from '../../../lib/db';
import { requireSession } from '../../../lib/session';

export interface CreateGiveawayFormState {
  issues?: string[];
  created?: boolean;
}

const SCHEDULE_TYPES = ['daily', 'weekly', 'monthly', 'flash'] as const;

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
  const entryCostTickets = Number(formData.get('entryCostTickets'));
  const minEntries = Number(formData.get('minEntries'));
  const scheduleType = String(formData.get('scheduleType') ?? '');
  const opensAt = mexicoCityDateTimeToUtc(String(formData.get('opensAt') ?? ''));
  const closesAt = mexicoCityDateTimeToUtc(String(formData.get('closesAt') ?? ''));

  if (!title) issues.push('Falta el título.');
  if (!description) issues.push('Falta la descripción.');
  if (!prizeDescription) issues.push('Falta la descripción del premio.');
  if (!Number.isFinite(entryCostTickets) || entryCostTickets < 1) {
    issues.push('El costo por entrada debe ser al menos 1 ticket.');
  }
  if (!Number.isFinite(minEntries) || minEntries < 0) {
    issues.push('El mínimo de entradas no puede ser negativo.');
  }
  if (!SCHEDULE_TYPES.includes(scheduleType as (typeof SCHEDULE_TYPES)[number])) {
    issues.push('Elige un tipo de sorteo.');
  }
  if (!opensAt) issues.push('La fecha de apertura no es válida.');
  if (!closesAt) issues.push('La fecha de cierre no es válida.');
  if (opensAt && closesAt && opensAt >= closesAt) issues.push('El cierre debe ser después de la apertura.');

  if (issues.length > 0 || !opensAt || !closesAt) return { issues };

  const input: CreateGiveawayInput = {
    title,
    description,
    prizeDescription,
    entryCostTickets: Math.trunc(entryCostTickets),
    scheduleType: scheduleType as CreateGiveawayInput['scheduleType'],
    minEntries: Math.trunc(minEntries),
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

const DRAW_FAILURE_LABEL: Record<'not_found' | 'wrong_status' | 'no_entries', string> = {
  not_found: 'No se encontró el sorteo.',
  wrong_status: 'Este sorteo todavía no está listo para sortear.',
  no_entries: 'Nadie participó en este sorteo.',
};

/** Admin-triggered only — the worker closes a giveaway for draw, but never picks the winner itself. */
export async function drawWinnerAction(_prev: DrawWinnerState, formData: FormData): Promise<DrawWinnerState> {
  const session = await requireSession();
  const id = String(formData.get('id') ?? '');

  const result = await new DrizzleGiveawayAdminStore(getDb()).drawWinner(id, session.adminUserId);
  if (!result.ok) return { error: DRAW_FAILURE_LABEL[result.reason] };

  revalidatePath('/sorteos');
  revalidatePath(`/sorteos/${id}`);
  return { ok: 'Ganador sorteado.' };
}

export async function markDeliveredAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const id = String(formData.get('id') ?? '');

  await new DrizzleGiveawayAdminStore(getDb()).markDelivered(id, session.adminUserId);

  revalidatePath('/sorteos');
  revalidatePath(`/sorteos/${id}`);
}
