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

/** Matches what `listTestimonials` will keep, so nothing is silently trimmed later. */
export const MAX_QUOTE = 400;
export const MAX_AUTHOR = 80;
export const MAX_COMBO = 80;
/** The trust page is a page, not an archive. Beyond this nobody reads them. */
export const MAX_TESTIMONIALS = 24;

export interface Testimonial {
  quote: string;
  author: string;
  /** Optional: which combo they bought, for context. */
  combo?: string;
}

export interface TestimonialIssue {
  /** Row number as the operator sees it, 1-based. */
  row: number;
  message: string;
}

/**
 * Check what an operator typed before it is written.
 *
 * Blank rows are dropped rather than reported — an empty row at the bottom of a
 * form is someone who added one and changed their mind, not a mistake. A row
 * that is half filled in IS reported, because dropping it silently would lose
 * something they meant to keep, and they would not find out until they looked
 * at the public page.
 *
 * Over-length is an error rather than a truncation for the same reason: a
 * testimonial cut off mid-sentence on the trust page is worse than being told
 * to shorten it.
 */
export function reviewTestimonials(drafts: readonly Partial<Testimonial>[]): {
  items: Testimonial[];
  issues: TestimonialIssue[];
} {
  const items: Testimonial[] = [];
  const issues: TestimonialIssue[] = [];

  drafts.forEach((draft, index) => {
    const row = index + 1;
    const quote = draft.quote?.trim() ?? '';
    const author = draft.author?.trim() ?? '';
    const combo = draft.combo?.trim() ?? '';

    if (!quote && !author && !combo) return;

    const before = issues.length;

    if (!quote) issues.push({ row, message: `Fila ${row}: falta el comentario.` });
    if (!author) issues.push({ row, message: `Fila ${row}: falta el nombre.` });
    if (quote.length > MAX_QUOTE) {
      issues.push({
        row,
        message: `Fila ${row}: el comentario tiene ${quote.length} caracteres, máximo ${MAX_QUOTE}.`,
      });
    }
    if (author.length > MAX_AUTHOR) {
      issues.push({ row, message: `Fila ${row}: el nombre es demasiado largo.` });
    }
    if (combo.length > MAX_COMBO) {
      issues.push({ row, message: `Fila ${row}: el nombre del paquete es demasiado largo.` });
    }

    // `items` is the valid set, so a row that raised anything stays out of it.
    // Callers refuse to save while there are issues, but a function that
    // reports a problem and hands back the offending row anyway is one
    // refactor away from writing it.
    if (issues.length === before) items.push({ quote, author, ...(combo ? { combo } : {}) });
  });

  if (items.length > MAX_TESTIMONIALS) {
    issues.push({
      row: MAX_TESTIMONIALS + 1,
      message: `Máximo ${MAX_TESTIMONIALS} testimonios. Quita algunos antes de guardar.`,
    });
  }

  return { items, issues };
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
    quote: t.quote.trim().slice(0, MAX_QUOTE),
    author: t.author.trim().slice(0, MAX_AUTHOR),
    ...(t.combo ? { combo: String(t.combo).slice(0, MAX_COMBO) } : {}),
  }));
}

/**
 * Replace the whole list.
 *
 * Whole-list rather than per-row edits because that is how the form works and
 * how the client thinks about it — a short page of quotes they rewrite now and
 * then, not records with identities. There is nothing to reference a single
 * testimonial by, and inventing ids would buy nothing.
 */
export async function saveTestimonials(db: Database, items: readonly Testimonial[]): Promise<void> {
  await db
    .insert(settings)
    .values({ key: TESTIMONIALS_KEY, value: { items } })
    .onConflictDoUpdate({ target: settings.key, set: { value: { items } } });
}
