import 'server-only';
import { countCompletedOrdersToday, countUniqueCustomers, listTestimonials } from '@levelup/db';
import { getDb } from './server';

export interface HomeActivity {
  recargasHoy: number;
  clientes: number;
  /** Mean of real rated testimonials. Null until there are enough to publish. */
  valoracion: number | null;
}

/**
 * Home-page activity strip. Counts are completed orders only, and "today" is
 * the Mexico City civil day inside `countCompletedOrdersToday`. The rating is
 * omitted until at least three real ratings exist so a single review cannot
 * paint the storefront.
 */
export async function loadHomeActivity(): Promise<HomeActivity> {
  const db = getDb();
  const [recargasHoy, clientes, testimonials] = await Promise.all([
    countCompletedOrdersToday(db),
    countUniqueCustomers(db),
    listTestimonials(db),
  ]);
  const rated = testimonials.filter((t) => typeof t.rating === 'number');
  const valoracion =
    rated.length >= 3 ? rated.reduce((sum, t) => sum + (t.rating as number), 0) / rated.length : null;
  return { recargasHoy, clientes, valoracion };
}
