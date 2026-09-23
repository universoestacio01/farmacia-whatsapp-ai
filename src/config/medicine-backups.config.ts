import { sanitizeEnv } from "./env-sanitize";

type Config = { get(key: string): unknown };
export const PHARMADB_BASE_URL = "https://api.pharmadb.com.br/v1";
export const BULAPI_BASE_URL = "https://bulapi.com.br/api/v1";
export function backupEnabled(value: unknown) {
  // Retired providers cannot be reactivated by old Hostinger environment values.
  void value;
  return false;
}
export function pharmaDbMultiplier(config?: Config) {
  const value = Number(
    sanitizeEnv(config?.get("PHARMADB_PMC_PRICE_MULTIPLIER")) || "0.5",
  );
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : 0.5;
}
export function backupPricePolicy(source: string, config?: Config) {
  if (source === "pharmadb")
    return `pharmadb_pf_or_pmc_v1:${pharmaDbMultiplier(config)}`;
  if (source === "bulapi") return "bulapi_max_pf_v1";
  return undefined;
}
export function hasBackupPrice(
  item: {
    source?: string;
    pricePolicy?: string;
    pricePf?: number;
    unitPrice?: number;
  },
  config?: Config,
) {
  void item;
  void config;
  return false;
}
export function backupProviderConfig(config: Config) {
  return {
    pharmadb: {
      enabled: backupEnabled(config.get("PHARMADB_ENABLED")),
      configured: Boolean(sanitizeEnv(config.get("PHARMADB_API_KEY"))),
      baseUrl:
        sanitizeEnv(config.get("PHARMADB_API_BASE_URL")) || PHARMADB_BASE_URL,
      priceRule: "PF; otherwise PMC multiplied by the configured factor",
      pmcMultiplier: pharmaDbMultiplier(config),
      lazy: true,
    },
    bulapi: {
      enabled: backupEnabled(config.get("BULAPI_ENABLED")),
      configured: true,
      baseUrl: sanitizeEnv(config.get("BULA_API_BASE_URL")) || BULAPI_BASE_URL,
      priceRule: "maximum PF for the exact presentation",
      lazy: true,
    },
  };
}
