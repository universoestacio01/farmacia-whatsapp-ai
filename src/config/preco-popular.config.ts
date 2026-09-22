import { sanitizeEnv } from "./env-sanitize";

export const PRECO_POPULAR_BASE_URL = "https://www.precopopular.com.br";

export function isPrecoPopularEnabled(value: unknown): boolean {
  return !["false", "0", "no", "nao"].includes(
    sanitizeEnv(value).toLowerCase(),
  );
}

export function getPrecoPopularMultiplier(value: unknown): number {
  const parsed = Number(sanitizeEnv(value));
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : 0.9;
}

export function calculatePrecoPopularSalePrice(
  price: number,
  multiplier = 0.9,
): number {
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Preco Popular: invalid price");
  }
  const cents = Math.round((price + Number.EPSILON) * 100);
  return (
    Math.max(1, Math.round(cents * getPrecoPopularMultiplier(multiplier))) / 100
  );
}
