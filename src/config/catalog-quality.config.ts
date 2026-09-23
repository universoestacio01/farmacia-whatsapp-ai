// Observed catalog data requiring verification. Never guess a replacement dose.
export const CATALOG_QUARANTINE = [
  {
    skuId: "6291",
    ean: "7891058003555",
    reason: "Puran cadastrado como 12,5mg; unidade pendente de verificacao",
  },
] as const;

export function catalogQuarantineReason(item: { sourceId?: string; ean?: string }) {
  return CATALOG_QUARANTINE.find((entry) => entry.skuId === item.sourceId || entry.ean === item.ean)?.reason;
}
