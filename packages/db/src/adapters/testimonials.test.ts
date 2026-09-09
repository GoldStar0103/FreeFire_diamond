import { describe, expect, it } from 'vitest';
import { MAX_QUOTE, MAX_TESTIMONIALS, reviewTestimonials } from './testimonials.js';

const ok = { quote: 'Súper rápido, llegaron en 2 minutos', author: 'Carlos M.' };

describe('reviewTestimonials', () => {
  it('accepts a filled-in row and trims it', () => {
    const { items, issues } = reviewTestimonials([
      { quote: '  Llegaron al instante  ', author: '  Ana L.  ', combo: '  Pack Insano  ' },
    ]);
    expect(issues).toEqual([]);
    expect(items).toEqual([{ quote: 'Llegaron al instante', author: 'Ana L.', combo: 'Pack Insano' }]);
  });

  it('omits the combo rather than storing an empty one', () => {
    const { items } = reviewTestimonials([{ ...ok, combo: '   ' }]);
    expect(items[0]).not.toHaveProperty('combo');
  });

  it('drops a blank row silently — that is someone changing their mind', () => {
    const { items, issues } = reviewTestimonials([ok, { quote: '', author: '', combo: '' }]);
    expect(items).toHaveLength(1);
    expect(issues).toEqual([]);
  });

  it('reports a half-filled row instead of dropping it', () => {
    // Dropping it silently loses something they meant to keep, and they would
    // not find out until they looked at the public page.
    const { items, issues } = reviewTestimonials([{ quote: 'Muy bueno', author: '' }]);
    expect(items).toEqual([]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/falta el nombre/i);
  });

  it('reports a missing comment', () => {
    const { issues } = reviewTestimonials([{ quote: '', author: 'Carlos M.' }]);
    expect(issues[0]?.message).toMatch(/falta el comentario/i);
  });

  it('numbers rows the way the operator sees them', () => {
    const { issues } = reviewTestimonials([ok, ok, { quote: 'x', author: '' }]);
    expect(issues[0]?.row).toBe(3);
    expect(issues[0]?.message).toContain('Fila 3');
  });

  it('rejects an over-long quote rather than truncating it', () => {
    // A testimonial cut off mid-sentence on the trust page is worse than being
    // told to shorten it.
    const { items, issues } = reviewTestimonials([{ ...ok, quote: 'a'.repeat(MAX_QUOTE + 1) }]);
    expect(items).toHaveLength(0);
    expect(issues[0]?.message).toContain(String(MAX_QUOTE));
  });

  it('accepts a quote of exactly the maximum length', () => {
    const { issues } = reviewTestimonials([{ ...ok, quote: 'a'.repeat(MAX_QUOTE) }]);
    expect(issues).toEqual([]);
  });

  it('caps the total', () => {
    const { issues } = reviewTestimonials(Array.from({ length: MAX_TESTIMONIALS + 1 }, () => ok));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/Máximo/);
  });

  it('allows exactly the maximum', () => {
    const { items, issues } = reviewTestimonials(
      Array.from({ length: MAX_TESTIMONIALS }, () => ok),
    );
    expect(items).toHaveLength(MAX_TESTIMONIALS);
    expect(issues).toEqual([]);
  });

  it('returns nothing for an empty form', () => {
    expect(reviewTestimonials([])).toEqual({ items: [], issues: [] });
  });

  it('keeps the operator’s ordering', () => {
    const { items } = reviewTestimonials([
      { quote: 'primero', author: 'A' },
      { quote: 'segundo', author: 'B' },
      { quote: 'tercero', author: 'C' },
    ]);
    expect(items.map((t) => t.quote)).toEqual(['primero', 'segundo', 'tercero']);
  });
});
