/**
 * Testimonials, stored as a setting the client edits.
 *
 * Deliberately data rather than hard-coded copy. Inventing reviews and showing
 * them to real buyers is fabricated social proof — and on a page whose entire
 * job is earning the trust of people who have been scammed before, made-up
 * quotes are exactly the wrong thing. These come from real customers or the
 * section does not render.
 */

import { eq } from 'drizzle-orm';
import type { Database } from '../index.js';
import { settings } from '../schema.js';

export const TESTIMONIALS_KEY = 'testimonials';

export interface Testimonial {
  quote: string;
  author: string;
  /** Optional: which combo they bought, for context. */
  combo?: string;
}

function isTestimonial(value: unknown): value is Testimonial {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.quote === 'string' &&
    t.quote.trim().length > 0 &&
    typeof t.author === 'string' &&
    t.author.trim().length > 0
  );
}

export async function listTestimonials(db: Database): Promise<Testimonial[]> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, TESTIMONIALS_KEY))
    .limit(1);

  const value = row?.value as { items?: unknown } | undefined;
  if (!Array.isArray(value?.items)) return [];

  // Filtered rather than trusted: this is operator-entered content rendered on
  // a public page, and a malformed entry should drop out, not break the page.
  return value.items.filter(isTestimonial).map((t) => ({
    quote: t.quote.trim().slice(0, 400),
    author: t.author.trim().slice(0, 80),
    ...(t.combo ? { combo: String(t.combo).slice(0, 80) } : {}),
  }));
}
