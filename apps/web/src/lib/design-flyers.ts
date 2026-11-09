/**
 * Approved redesign flyers (LevelUp_Rediseno_Aprobado_2026-10-29).
 *
 * Live campaigns still store operator-uploaded assets under `flyers/…`. Those
 * images are often outdated relative to the approved art, so the promociones
 * surface prefers these static redesign files when a campaign matches.
 */

const DESIGN_FLYERS: ReadonlyArray<{
  src: string;
  match: (key: string, name: string) => boolean;
}> = [
  {
    src: '/design/promociones/flyer-mega-oferta110.webp',
    match: (key, name) =>
      key.includes('mega_oferta') ||
      (name.includes('mega oferta') && !name.includes('prime')),
  },
  {
    // Approved promociones redesign uses Mini Packs here (not Descuentos Chidos).
    src: '/design/promociones/flyer-mini-packs.webp',
    match: (key, name) =>
      key.includes('mini') ||
      name.includes('mini pack') ||
      key.includes('descuento') ||
      key.includes('chidos') ||
      name.includes('descuento') ||
      name.includes('chidos'),
  },
  {
    // Approved promociones redesign uses ¿Dulce o Diamantes? here (not Lluvia).
    src: '/design/promociones/flyer-dulce-odiamantes.webp',
    match: (key, name) =>
      key.includes('dulce') ||
      name.includes('dulce') ||
      key.includes('lluvia') ||
      name.includes('lluvia'),
  },
  {
    src: '/design/promociones/flyer-energia-insana.webp',
    match: (key, name) =>
      key.includes('energia') || name.includes('energia') || name.includes('insana'),
  },
  {
    src: '/design/promociones/flyer-super-packs.webp',
    match: (key, name) => key.includes('super_pack') || name.includes('super pack'),
  },
  {
    src: '/design/promociones/flyer-packs-mega-prime.webp',
    match: (key, name) =>
      key.includes('mega_prime') ||
      key.includes('packs_mega') ||
      name.includes('mega prime'),
  },
];

/** Redesign flyer path for a campaign, or null when no approved art maps. */
export function designFlyerSrc(
  campaignKey: string,
  campaignName: string,
): string | null {
  const key = campaignKey.toLowerCase();
  const name = campaignName.toLowerCase();
  return DESIGN_FLYERS.find((entry) => entry.match(key, name))?.src ?? null;
}
