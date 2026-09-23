import { sanitizeEnv } from "./env-sanitize";

export const WEB_MEDICINE_PRICE_POLICY = "web_public_brl_exact_pack_v1";
export const WEB_MEDICINE_DOMAINS = [
  "precopopular.com.br",
  "drogaraia.com.br",
  "drogasil.com.br",
  "drogariasaopaulo.com.br",
  "drogariaspacheco.com.br",
] as const;
export const WEB_QUOTE_TTL_MS = 10 * 60 * 1000;
type Config = { get(key: string): unknown };

export function webMedicineConfig(config: Config) {
  const limit = Number(
    sanitizeEnv(config.get("OPENAI_WEB_SEARCH_DAILY_LIMIT")) || 40,
  );
  return {
    enabled: !["false", "0", "no", "nao"].includes(
      sanitizeEnv(config.get("OPENAI_WEB_SEARCH_ENABLED")).toLowerCase(),
    ),
    configured: Boolean(sanitizeEnv(config.get("OPENAI_API_KEY"))),
    model: sanitizeEnv(config.get("OPENAI_WEB_SEARCH_MODEL")) || "gpt-5-mini",
    dailyLimit:
      Number.isInteger(limit) && limit >= 0 && limit <= 1000 ? limit : 40,
    allowedDomains: [...WEB_MEDICINE_DOMAINS],
    priceRule:
      "100% do preco publico BRL da embalagem exata, sem desconto adicional",
    connectivityChecked: false,
  };
}

export function safeMedicineProductUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 1200) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      !WEB_MEDICINE_DOMAINS.some((domain) => host === domain) ||
      !/(?:\.html|\/p)\/?$/i.test(url.pathname)
    )
      return null;
    url.hostname = host;
    url.hash = "";
    url.search = "";
    return url.href;
  } catch {
    return null;
  }
}

export interface WebMedicineQuote {
  sourceUrl: string;
  observedAt: string;
  expiresAt: string;
  productName: string;
  priceCents: number;
  ean?: string;
}

export function validWebQuote(item: {
  source?: string;
  pricePolicy?: string;
  pricePf?: number;
  unitPrice?: number;
  webQuote?: WebMedicineQuote;
}) {
  const quote = item.webQuote;
  const price = item.pricePf ?? item.unitPrice;
  return Boolean(
    item.source === "openai_web" &&
    item.pricePolicy === WEB_MEDICINE_PRICE_POLICY &&
    quote &&
    safeMedicineProductUrl(quote.sourceUrl) &&
    typeof price === "number" &&
    Number.isFinite(price) &&
    price > 0 &&
    Math.round(price * 100) === quote.priceCents &&
    Date.parse(quote.expiresAt) > Date.now() &&
    Date.parse(quote.observedAt) <= Date.now() &&
    Date.parse(quote.expiresAt) - Date.parse(quote.observedAt) <=
      WEB_QUOTE_TTL_MS,
  );
}
