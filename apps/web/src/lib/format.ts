const MXN = new Intl.NumberFormat('es-MX', {
  style: 'currency',
  currency: 'MXN',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const NUM = new Intl.NumberFormat('es-MX');

/** Storefront prices are whole pesos — no combo has centavos. */
export const mxn = (centavos: number): string => MXN.format(centavos / 100);
export const diamonds = (value: number): string => NUM.format(value);
