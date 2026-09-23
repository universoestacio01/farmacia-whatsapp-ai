import { sanitizeEnv } from "./env-sanitize";

export const PRECO_POPULAR_BASE_URL = "https://www.precopopular.com.br";
export const CATALOG_PRICE_POLICY = "preco_popular_full_v1";

export function isPrecoPopularEnabled(value: unknown): boolean {
  return !["false", "0", "no", "nao"].includes(
    sanitizeEnv(value).toLowerCase(),
  );
}

export function getPrecoPopularMultiplier(_legacyValue?: unknown): number {
  // Old deployments may still set 0.9. Prices now always follow the catalog.
  return 1;
}

export function calculatePrecoPopularSalePrice(
  price: number,
  _legacyMultiplier?: number,
): number {
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Preco Popular: invalid price");
  }
  const cents = Math.round((price + Number.EPSILON) * 100);
  return Math.max(1, cents) / 100;
}
