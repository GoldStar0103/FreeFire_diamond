'use server';

import { reviewTestimonials, saveTestimonials, type Testimonial } from '@levelup/db';
import { db } from '../../../lib/db';
import { requireSession } from '../../../lib/session';

export interface TestimonialsFormState {
  saved?: boolean;
  issues?: string[];
  /** Echoed back so a rejected save does not wipe what the operator typed. */
  draft?: Testimonial[];
}

export async function saveTestimonialsAction(
  _prev: TestimonialsFormState,
  formData: FormData,
): Promise<TestimonialsFormState> {
  // A server action is a public endpoint. The panel layout's gate does not
  // cover it.
  await requireSession();

  const quotes = formData.getAll('quote').map(String);
  const authors = formData.getAll('author').map(String);
  const combos = formData.getAll('combo').map(String);

  const drafts = quotes.map((quote, i) => ({
    quote,
    author: authors[i] ?? '',
    combo: combos[i] ?? '',
  }));

  const { items, issues } = reviewTestimonials(drafts);

  if (issues.length > 0) {
    // Nothing is written on any issue, including ones affecting a single row.
    // A partial save would leave the operator looking at a form that no longer
    // matches what is public.
    return { issues: issues.map((i) => i.message), draft: drafts };
  }

  await saveTestimonials(db, items);

  // No revalidation call: the storefront is a separate Next process, so this
  // app's cache has nothing to invalidate for it. /confianza is force-dynamic
  // and reads the row on every request, so the change is live immediately.
  return { saved: true, draft: items };
}
