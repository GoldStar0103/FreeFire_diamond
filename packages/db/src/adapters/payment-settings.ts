/**
 * Where customers are told to send their money.
 *
 * This lived in environment variables, which was wrong in two ways. Changing a
 * bank account needed a redeploy — and small Mexican merchants change accounts
 * more often than they would like, sometimes because one gets frozen. Worse,
 * the variables were undocumented and defaulted to empty strings, so an
 * unconfigured deployment showed a customer a blank account number at the exact
 * moment they were trying to pay.
 *
 * So it is a settings row the owner edits, and the storefront refuses to show a
 * payment box it cannot fill in.
 */

import { eq } from 'drizzle-orm';
import type { Database } from '../index.js';
import { settings } from '../schema.js';

export const PAYMENT_DETAILS_KEY = 'payment_details';
export const FX_RATE_KEY = 'fx_usd_mxn';

export interface PaymentDetails {
  /** Bank name shown next to the CLABE, e.g. "BBVA". */
  bank: string;
  /** 18-digit interbank account number. */
  clabe: string;
  /** Account holder, as it appears at the bank. */
  holder: string;
  /** Card or reference number for an OXXO deposit. Optional. */
  oxxo: string | null;
}

export interface SettingIssue {
  field: 'bank' | 'clabe' | 'holder' | 'oxxo' | 'fxRate';
  message: string;
}

/** Digits only, so an operator can paste "012 180 01234567890 1" and it works. */
const digits = (value: string): string => value.replace(/\D/g, '');

/**
 * CLABE check digit.
 *
 * The 18th digit is a checksum over the first 17, weighted 3-7-1 repeating.
 * Validating it catches the transposed or dropped digit that a length check
 * cannot — which is the difference between a failed transfer and money arriving
 * in a stranger's account. It is a genuine standard, not a heuristic.
 */
export function isValidClabe(value: string): boolean {
  const d = digits(value);
  if (d.length !== 18) return false;

  const weights = [3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    // Each digit contributes only its last decimal place, per the standard.
    sum += ((Number(d[i]) * weights[i % 3]!) % 10);
  }

  const expected = (10 - (sum % 10)) % 10;
  return expected === Number(d[17]);
}

export function reviewPaymentDetails(draft: Partial<PaymentDetails>): {
  details: PaymentDetails | null;
  issues: SettingIssue[];
} {
  const issues: SettingIssue[] = [];

  const bank = draft.bank?.trim() ?? '';
  const holder = draft.holder?.trim() ?? '';
  const clabeRaw = draft.clabe?.trim() ?? '';
  const oxxoRaw = draft.oxxo?.trim() ?? '';

  if (!bank) issues.push({ field: 'bank', message: 'Escribe el nombre del banco.' });
  if (bank.length > 60) issues.push({ field: 'bank', message: 'El nombre del banco es muy largo.' });

  if (!holder) {
    issues.push({ field: 'holder', message: 'Escribe el nombre del titular de la cuenta.' });
  }
  if (holder.length > 120) {
    issues.push({ field: 'holder', message: 'El nombre del titular es muy largo.' });
  }

  const clabe = digits(clabeRaw);
  if (!clabe) {
    issues.push({ field: 'clabe', message: 'Escribe la CLABE.' });
  } else if (clabe.length !== 18) {
    issues.push({
      field: 'clabe',
      message: `La CLABE debe tener 18 dígitos; ésta tiene ${clabe.length}.`,
    });
  } else if (!isValidClabe(clabe)) {
    // Almost always a typo. Saying so is more useful than "inválida".
    issues.push({
      field: 'clabe',
      message: 'La CLABE tiene 18 dígitos pero no es válida. Revisa que no falte o sobre un número.',
    });
  }

  const oxxo = digits(oxxoRaw);
  if (oxxoRaw && (oxxo.length < 10 || oxxo.length > 19)) {
    issues.push({
      field: 'oxxo',
      message: 'El número de OXXO debe tener entre 10 y 19 dígitos, o déjalo vacío.',
    });
  }

  if (issues.length > 0) return { details: null, issues };

  return { details: { bank, clabe, holder, oxxo: oxxo || null }, issues };
}

function isPaymentDetails(value: unknown): value is PaymentDetails {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.bank === 'string' &&
    typeof v.clabe === 'string' &&
    typeof v.holder === 'string' &&
    v.bank.trim() !== '' &&
    v.clabe.trim() !== '' &&
    v.holder.trim() !== ''
  );
}

/**
 * Read the configured details, or null when there are none.
 *
 * Null is a real answer, not an error: it means the storefront must not offer a
 * bank transfer. Falling back to a placeholder is how a blank account number
 * reached a customer in the first place.
 *
 * The environment variables are honoured as a bootstrap so an existing
 * deployment keeps working across this change; the settings row wins once the
 * owner saves anything.
 */
export async function getPaymentDetails(db: Database): Promise<PaymentDetails | null> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, PAYMENT_DETAILS_KEY))
    .limit(1);

  if (isPaymentDetails(row?.value)) {
    const v = row.value;
    return {
      bank: v.bank.trim(),
      clabe: digits(v.clabe),
      holder: v.holder.trim(),
      oxxo: v.oxxo ? digits(String(v.oxxo)) || null : null,
    };
  }

  return paymentDetailsFromEnv();
}

/** The pre-settings configuration path. Kept so an upgrade is not a outage. */
export function paymentDetailsFromEnv(env = process.env): PaymentDetails | null {
  const bank = env.PAY_BANK?.trim();
  const clabe = env.PAY_CLABE ? digits(env.PAY_CLABE) : '';
  const holder = env.PAY_HOLDER?.trim();

  if (!bank || !clabe || !holder) return null;

  const oxxo = env.PAY_OXXO ? digits(env.PAY_OXXO) : '';
  return { bank, clabe, holder, oxxo: oxxo || null };
}

export async function savePaymentDetails(db: Database, details: PaymentDetails): Promise<void> {
  await db
    .insert(settings)
    .values({ key: PAYMENT_DETAILS_KEY, value: details })
    .onConflictDoUpdate({ target: settings.key, set: { value: details } });
}

// ── exchange rate ─────────────────────────────────────────────────────────────

/** Only ever used to show costs and margins in the panel. Never charges anyone. */
export const DEFAULT_FX_RATE = 18.5;

export async function getFxRate(db: Database): Promise<number> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, FX_RATE_KEY))
    .limit(1);

  const rate = (row?.value as { rate?: unknown } | undefined)?.rate;
  if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) return rate;

  const fromEnv = Number(process.env.FX_USD_MXN);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_FX_RATE;
}

export function reviewFxRate(raw: string): { rate: number | null; issues: SettingIssue[] } {
  const rate = Number(raw.trim().replace(',', '.'));

  if (!Number.isFinite(rate) || rate <= 0) {
    return { rate: null, issues: [{ field: 'fxRate', message: 'El tipo de cambio debe ser un número mayor que cero.' }] };
  }

  // Not a currency check, a fat-finger check: the peso has not been outside
  // this range in decades, and 185 instead of 18.5 would misreport every
  // margin in the panel by a factor of ten.
  if (rate < 5 || rate > 100) {
    return {
      rate: null,
      issues: [{ field: 'fxRate', message: 'Ese tipo de cambio no parece correcto. Debe estar entre 5 y 100.' }],
    };
  }

  return { rate, issues: [] };
}

export async function saveFxRate(db: Database, rate: number): Promise<void> {
  await db
    .insert(settings)
    .values({ key: FX_RATE_KEY, value: { rate } })
    .onConflictDoUpdate({ target: settings.key, set: { value: { rate } } });
}
