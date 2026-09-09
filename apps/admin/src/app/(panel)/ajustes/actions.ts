'use server';

import {
  reviewFxRate,
  reviewPaymentDetails,
  saveFxRate,
  savePaymentDetails,
} from '@levelup/db';
import { getDb } from '../../../lib/db';
import { requireSession } from '../../../lib/session';

export interface SettingsFormState {
  saved?: boolean;
  issues?: string[];
}

/**
 * Where customers send their money, and the rate used to show costs.
 *
 * Saved together because they are one screen to the owner, but validated
 * independently — a wrong exchange rate should not stop him correcting a bank
 * account, which is the urgent one.
 */
export async function saveSettings(
  _prev: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  // A server action is a public endpoint; the panel layout's gate does not
  // cover it. This one changes where every customer is told to send money.
  await requireSession();

  const { details, issues: payIssues } = reviewPaymentDetails({
    bank: String(formData.get('bank') ?? ''),
    clabe: String(formData.get('clabe') ?? ''),
    holder: String(formData.get('holder') ?? ''),
    oxxo: String(formData.get('oxxo') ?? ''),
  });

  const { rate, issues: fxIssues } = reviewFxRate(String(formData.get('fxRate') ?? ''));

  const issues = [...payIssues, ...fxIssues];
  if (issues.length > 0 || !details || rate === null) {
    // Nothing is written if anything is wrong. A half-saved payment screen is
    // the failure this whole change exists to remove.
    return { issues: issues.map((i) => i.message) };
  }

  await savePaymentDetails(getDb(), details);
  await saveFxRate(getDb(), rate);

  return { saved: true };
}
