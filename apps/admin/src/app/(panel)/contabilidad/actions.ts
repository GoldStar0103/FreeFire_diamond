'use server';

import { revalidatePath } from 'next/cache';
import { addManualLedgerEntry, deleteManualLedgerEntry } from '@levelup/db';
import { getDb } from '../../../lib/db';
import { requireSession } from '../../../lib/session';

export interface ManualEntryState {
  ok?: string;
  error?: string;
}

/**
 * Pesos as typed by a human -> integer centavos. Accepts "1234.50", "1,234.5"
 * and "1234"; refuses anything else rather than guessing, because a silently
 * misparsed expense is worse than a rejected one.
 */
function parsePesos(raw: string): number | null {
  const cleaned = raw.replace(/[\s,$]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

export async function addLedgerEntry(
  _prev: ManualEntryState,
  formData: FormData,
): Promise<ManualEntryState> {
  const session = await requireSession();

  const kind = String(formData.get('kind') ?? 'expense') === 'income' ? 'income' : 'expense';
  const amountCents = parsePesos(String(formData.get('amount') ?? ''));
  const note = String(formData.get('note') ?? '');
  const dateRaw = String(formData.get('date') ?? '').trim();

  if (amountCents === null) return { error: 'Escribe el monto en pesos, por ejemplo 1250.00' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) return { error: 'Elige una fecha.' };

  // Noon Mexico City (UTC-6), so the entry lands on the day the admin picked
  // whatever the server's own clock is doing.
  const occurredAt = new Date(`${dateRaw}T18:00:00.000Z`);

  const result = await addManualLedgerEntry(getDb(), {
    kind,
    amountCents,
    occurredAt,
    note,
    adminUserId: session.adminUserId,
  });

  if (!result.ok) {
    return {
      error:
        result.reason === 'note_required'
          ? 'Escribe una nota corta: en un mes nadie va a recordar qué fue.'
          : 'Ese monto no es válido.',
    };
  }

  revalidatePath('/contabilidad');
  return { ok: kind === 'expense' ? 'Gasto registrado.' : 'Ingreso registrado.' };
}

export async function removeLedgerEntry(formData: FormData): Promise<void> {
  const session = await requireSession();
  const id = String(formData.get('id') ?? '');
  if (!id) return;

  await deleteManualLedgerEntry(getDb(), id, session.adminUserId);
  revalidatePath('/contabilidad');
}
