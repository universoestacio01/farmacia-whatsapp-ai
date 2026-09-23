import { parse, DefaultTreeAdapterMap } from "parse5";
import { createHash } from "node:crypto";
import {
  safeMedicineProductUrl,
  WEB_QUOTE_TTL_MS,
} from "../config/web-medicine.config";
import { CommercialMedicineSelector } from "./commercial-medicine-selector";
import { NormalizedMedicineOption } from "./medicine-provider.interface";
import {
  extractMedicineStrengths,
  medicinePresentationStrengthMatches,
} from "../utils/medicine-strength.util";
import { catalogQuarantineReason } from "../config/catalog-quality.config";

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value == null ? [] : [value];
const text = (value: unknown) => (typeof value === "string" ? value : "");
const fold = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

function concreteOffers(value: unknown, sku: unknown): JsonObject[] {
  return array(value).flatMap((entry) => {
    const item = object(entry);
    if (item["@type"] === "AggregateOffer") {
      return array(item.offers)
        .map(object)
        .filter(
          (offer) => !offer.sku || !sku || String(offer.sku) === String(sku),
        );
    }
    return [item];
  });
}

function verifiedGtin(value: unknown): string | undefined {
  const code = text(value).trim();
  if (!/^(?:\d{8}|\d{12,14})$/.test(code) || /^0+$/.test(code))
    return undefined;
  let sum = 0;
  for (
    let index = code.length - 2, weight = 3;
    index >= 0;
    index--, weight = weight === 3 ? 1 : 3
  )
    sum += Number(code[index]) * weight;
  return (10 - (sum % 10)) % 10 === Number(code.at(-1)) ? code : undefined;
}

export function productJsonLd(html: string): JsonObject[] {
  const products: JsonObject[] = [];
  const inspect = (value: unknown, depth = 0) => {
    if (depth > 12) return;
    for (const entry of array(value)) {
      const node = object(entry);
      if (
        array(node["@type"]).some(
          (type) => type === "Product" || type === "https://schema.org/Product",
        )
      )
        products.push(node);
      for (const field of ["@graph", "mainEntity", "hasVariant"])
        if (node[field]) inspect(node[field], depth + 1);
    }
  };
  const walk = (node: DefaultTreeAdapterMap["node"]) => {
    if (
      "tagName" in node &&
      node.tagName === "script" &&
      node.attrs.some(
        (attr) =>
          attr.name === "type" &&
          attr.value.toLowerCase() === "application/ld+json",
      )
    ) {
      const body = node.childNodes
        .filter((child) => child.nodeName === "#text")
        .map((child) => ("value" in child ? child.value : ""))
        .join("");
      try {
        inspect(JSON.parse(body));
      } catch {
        /* Invalid structured data is not a price source. */
      }
    }
    if ("childNodes" in node) for (const child of node.childNodes) walk(child);
  };
  walk(parse(html));
  return products;
}

function publicPrice(offer: JsonObject, sourceUrl: string): number | null {
  if (
    !array(offer["@type"]).some(
      (type) => type === "Offer" || type === "https://schema.org/Offer",
    )
  )
    return null;
  if (
    offer.priceCurrency !== "BRL" ||
    !/^https?:\/\/schema\.org\/InStock$/.test(text(offer.availability))
  )
    return null;
  if (offer.url && safeMedicineProductUrl(offer.url) !== sourceUrl) return null;
  if (offer.priceValidUntil) {
    const value = String(offer.priceValidUntil);
    const end = /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? Date.parse(`${value}T23:59:59-03:00`)
      : Date.parse(value);
    if (!(end > Date.now())) return null;
  }
  if (
    offer.itemCondition &&
    !/^https?:\/\/schema\.org\/NewCondition$/.test(text(offer.itemCondition))
  )
    return null;
  // Only unconditional single-package offers. Aggregate/loyalty/installment prices are not usable.
  if (
    [
      "eligibleCustomerType",
      "eligibleRegion",
      "eligibleQuantity",
      "validForMemberTier",
      "membershipNumber",
      "priceSpecification",
    ].some((key) => offer[key] != null)
  )
    return null;
  if (
    /\b(cpf|convenio|cupom|assinatura|fidelidade|clube|parcelas?|a partir|pbm|leve \d|compre \d)\b/i.test(
      fold(JSON.stringify(offer)),
    )
  )
    return null;
  const raw = offer.price;
  if (
    !(
      typeof raw === "number" ||
      (typeof raw === "string" && /^\d+(?:\.\d{1,2})?$/.test(raw))
    )
  )
    return null;
  const cents = Math.round(Number(raw) * 100);
  return Number.isSafeInteger(cents) && cents > 0 && cents <= 1000000
    ? cents
    : null;
}

export function extractVerifiedWebOptions(
  html: string,
  url: string,
  query: string,
  selector: CommercialMedicineSelector,
): NormalizedMedicineOption[] {
  const sourceUrl = safeMedicineProductUrl(url);
  if (!sourceUrl) return [];
  const requested = selector.parseMedicineQuery(query);
  const options: NormalizedMedicineOption[] = [];
  for (const product of productJsonLd(html)) {
    const name = text(product.name).trim();
    if (!name || name.length > 240 || /[<>\r\n]/.test(name)) continue;
    if (product.url && safeMedicineProductUrl(product.url) !== sourceUrl)
      continue;
    const requestedName = requested.medicineName || query;
    if (!selector.isSameMedicine(requestedName, { id: 0, name })) continue;
    // Preserve explicitly named brands; never infer equivalence from model prose.
    if (
      requested.canonicalName &&
      fold(requestedName) !== fold(requested.canonicalName) &&
      !fold(name).includes(fold(requestedName))
    )
      continue;
    const info = selector.extractPackageInfo(name);
    const units = fold(name).match(
      /\b(\d{1,4})\s*(?:comprimidos?|capsulas?|drageas?|unidades?)\b/,
    );
    if (info.unitCount === undefined && units)
      info.unitCount = Number(units[1]);
    const dosage =
      extractMedicineStrengths(name)
        .map((strength) => strength.label)
        .join("+") || undefined;
    if (
      requested.dosage &&
      !medicinePresentationStrengthMatches(dosage || "", requested.dosage, name)
    )
      continue;
    if (requested.formGroup && info.formGroup !== requested.formGroup) continue;
    if (
      requested.packageQuantity !== undefined &&
      info.unitCount !== requested.packageQuantity
    )
      continue;
    if (
      requested.volumeMl !== undefined &&
      info.volumeMl !== requested.volumeMl
    )
      continue;
    if (!info.unitCount && !info.volumeMl) continue;
    if (info.formGroup === "outro") continue;
    const ean = verifiedGtin(product.gtin13 || product.gtin);
    if (catalogQuarantineReason({ ean })) continue;
    const prices = concreteOffers(product.offers, product.sku)
      .map((offer) => publicPrice(offer, sourceUrl))
      .filter((price): price is number => price !== null);
    if (!prices.length || new Set(prices).size !== 1) continue;
    const priceCents = prices[0];
    const observedAt = new Date().toISOString();
    options.push({
      source: "openai_web",
      sourceId: createHash("sha256")
        .update(`${sourceUrl}|${ean || ""}|${fold(name)}`)
        .digest("hex")
        .slice(0, 24),
      productName: name,
      displayName: name,
      brand:
        text(object(product.brand).name) || text(product.brand) || undefined,
      dosage,
      form: info.formGroup,
      presentation: name,
      packageInfo: { ...info, raw: name },
      salePrice: priceCents / 100,
      ean,
      availabilityStatus: "active",
      webQuote: {
        sourceUrl,
        observedAt,
        expiresAt: new Date(Date.now() + WEB_QUOTE_TTL_MS).toISOString(),
        productName: name,
        priceCents,
        ean,
      },
    });
  }
  return options;
}
