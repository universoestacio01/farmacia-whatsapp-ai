import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ProviderRequestOutcome } from "@prisma/client";
import { z } from "zod";
import {
  calculatePrecoPopularSalePrice,
  isPrecoPopularEnabled,
  PRECO_POPULAR_BASE_URL,
} from "../config/preco-popular.config";
import { ProviderRequestLogService } from "../observability/provider-request-log.service";
import { formatProductDisplayName } from "../whatsapp/whatsapp-copy";
import { CommercialMedicineSelector } from "./commercial-medicine-selector";
import { NormalizedMedicineOption } from "./medicine-provider.interface";
import { NormalizedRetailProduct } from "./product-provider.interface";
import { extractMedicineStrengths, removeMedicineStrengths } from "../utils/medicine-strength.util";
import { CATALOG_QUARANTINE } from "../config/catalog-quality.config";

export type CatalogSearchStatus = "ok" | "incomplete" | "unavailable" | "disabled";
interface CatalogSearchResult {
  products: CatalogProduct[];
  status: CatalogSearchStatus;
  failureReason?: string;
}

const numberSchema = z
  .union([z.number(), z.string().min(1)])
  .transform(Number)
  .refine(Number.isFinite);
const productSchema = z
  .object({
    productId: z.union([z.string(), z.number()]),
    productName: z.string().min(1),
    brand: z.string().optional(),
    categories: z.array(z.string()).optional(),
    items: z.array(
      z.object({
        itemId: z.union([z.string(), z.number()]),
        name: z.string().optional(),
        nameComplete: z.string().optional(),
        ean: z.string().optional(),
        images: z.array(z.object({ imageUrl: z.string() })).optional(),
        sellers: z.array(
          z.object({
            sellerDefault: z.boolean().optional(),
            commertialOffer: z
              .object({
                Price: numberSchema.optional(),
                AvailableQuantity: numberSchema.optional(),
                IsAvailable: z.boolean().optional(),
              })
              .passthrough(),
          }),
        ),
      }),
    ),
  })
  .passthrough();

interface CatalogProduct {
  skuId: string;
  name: string;
  brand?: string;
  ean?: string;
  imageUrl?: string;
  category?: string;
  activeIngredient?: string;
  isMedicine: boolean;
  price: number;
  salePrice: number;
}

@Injectable()
export class PrecoPopularService {
  readonly name = "preco_popular" as const;
  private readonly logger = new Logger(PrecoPopularService.name);
  private readonly cache = new Map<
    string,
    { expiresAt: number; result: CatalogSearchResult }
  >();
  private readonly inFlight = new Map<string, Promise<CatalogSearchResult>>();
  private cooldownUntil = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly selector: CommercialMedicineSelector,
    private readonly requestLog?: ProviderRequestLogService,
  ) {}

  isEnabled() {
    return isPrecoPopularEnabled(this.config.get("PRECO_POPULAR_ENABLED"));
  }

  async searchMedicines(query: string): Promise<NormalizedMedicineOption[]> {
    return (await this.searchMedicinesWithStatus(query)).options;
  }

  async searchMedicinesWithStatus(query: string) {
    const parsed = this.selector.parseMedicineQuery(query);
    const term = parsed.medicineName || parsed.canonicalName || "";
    const result = await this.searchCatalog(term);
    const options: NormalizedMedicineOption[] = result.products
      .filter((product) => product.isMedicine)
      .map((product) => {
        const text = this.normalize(product.name);
        const strengths = extractMedicineStrengths(text);
        const packagingText = removeMedicineStrengths(text);
        const units = packagingText.match(
          /\b(\d+)\s*(?:comprimidos?|capsulas?|drageas?|unidades?|supositorios?|cp|comp|caps)\b/,
        );
        const volume = packagingText.match(/\b(\d+(?:[,.]\d+)?)\s*ml\b/);
        // "com 28 capsulas" is ordinary Portuguese, not the CMED abbreviation COM.
        const info = this.selector.extractPackageInfo(
          text.replace(/\bcom\b/g, " "),
        );
        const unitCount = units ? Number(units[1]) : undefined;
        const volumeMl = volume
          ? Number(volume[1].replace(",", "."))
          : undefined;
        const incompleteConcentration = Boolean(volumeMl && strengths.length && strengths.some((strength) => !strength.denominator) &&
          !["comprimido", "capsula", "dragea"].includes(info.formGroup));
        const dosage = incompleteConcentration ? undefined : strengths.map((strength) => strength.label).join("+") || undefined;
        if (incompleteConcentration) this.logger.warn(JSON.stringify({ provider: this.name, sourceId: product.skuId, reason: "unverified_liquid_concentration", name: product.name }));
        return {
          source: this.name,
          sourceId: product.skuId,
          productName: product.name,
          displayName: formatProductDisplayName(product.name),
          activeIngredient: product.activeIngredient,
          substance: product.activeIngredient,
          brand: product.brand,
          ean: product.ean,
          imageUrl: product.imageUrl,
          dosage,
          form: info.formGroup,
          presentation: product.name,
          packageInfo: {
            raw: [
              info.formGroup,
              unitCount ? `${unitCount} unidades` : "",
              volumeMl ? `${volumeMl}ml` : "",
            ]
              .filter(Boolean)
              .join(" "),
            unitCount,
            volumeMl,
            isHospitalUse: info.isHospitalUse,
            isInjectable: info.isInjectable,
          },
          salePrice: product.salePrice,
          priceConsumer: product.price,
        };
      });
    return { options, status: result.status, failureReason: result.failureReason };
  }

  async searchRetail(query: string): Promise<NormalizedRetailProduct[]> {
    return (await this.searchRetailWithStatus(query)).options;
  }

  async searchRetailWithStatus(query: string) {
    const result = await this.searchCatalog(this.cleanRetailQuery(query));
    const options = result.products
      .filter((product) => !product.isMedicine)
      .map((product) => this.toRetail(product));
    return { options, status: result.status, failureReason: result.failureReason };
  }

  async findRetailByGtin(
    gtin: string,
  ): Promise<NormalizedRetailProduct | null> {
    if (!/^(?:\d{8}|\d{12,14})$/.test(gtin)) return null;
    const { products } = await this.searchCatalog(gtin, "ean");
    const product = products.find(
      (item) => item.ean === gtin && !item.isMedicine,
    );
    return product ? this.toRetail(product) : null;
  }

  async findCurrentOffer(item: { source?: string; sourceId?: string; ean?: string }) {
    const useEan = /^(?:\d{8}|\d{12,14})$/.test(item.ean || "");
    const useSku = item.source === this.name && /^\d+$/.test(item.sourceId || "");
    if (!useEan && !useSku) return null;
    const { products } = await this.searchCatalog(
      useEan ? item.ean! : item.sourceId!,
      useEan ? "ean" : "sku",
    );
    const match = products.find((product) => useEan
      ? product.ean === item.ean
      : product.skuId === item.sourceId);
    return match ? { source: this.name, sourceId: match.skuId, ean: match.ean, price: match.salePrice } : null;
  }

  private toRetail(product: CatalogProduct): NormalizedRetailProduct {
    return {
      source: this.name,
      sourceId: product.skuId,
      productName: product.name,
      displayName: formatProductDisplayName(product.name),
      brand: product.brand,
      gtin: product.ean,
      ean: product.ean,
      category: product.category,
      imageUrl: product.imageUrl,
      referencePrice: product.price,
      salePrice: product.salePrice,
      salePriceSource: "preco_popular",
    };
  }

  private async searchCatalog(
    term: string,
    queryType: "name" | "ean" | "sku" = "name",
  ): Promise<CatalogSearchResult> {
    if (!this.isEnabled()) return { products: [], status: "disabled" };
    if (term.length < 2 || term.length > 200) return { products: [], status: "ok" };
    const key = `${queryType}:${this.normalize(term)}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.result;
    if (this.cooldownUntil > Date.now()) {
      this.logger.warn(JSON.stringify({ provider: this.name, term, reason: "provider_cooldown" }));
      return { products: [], status: "unavailable", failureReason: "provider_cooldown" };
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const request = this.fetchCatalog(term, queryType)
      .then((result) => {
        if (result.status === "unavailable") return result;
        if (this.cache.size >= 200)
          this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, {
          result,
          expiresAt: Date.now() + (result.status === "incomplete" ? 15_000 : result.products.length ? 300_000 : 30_000),
        });
        return result;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    return request;
  }

  private async fetchCatalog(
    term: string,
    queryType: "name" | "ean" | "sku",
  ): Promise<CatalogSearchResult> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const products = new Map<string, CatalogProduct>();
    let endpoint = "";
    let status: number | undefined;
    let complete = false;
    let failureReason = "pagination_limit";
    const seenPages = new Set<string>();
    const discardedTotals = { noPrice: 0, unavailable: 0, quarantined: 0 };
    try {
      // Bounded pagination shares one timeout; never request details per SKU.
      for (let page = 0; page < 4; page += 1) {
        const url = new URL(
          "/api/catalog_system/pub/products/search",
          PRECO_POPULAR_BASE_URL,
        );
        url.searchParams.set(
          queryType === "name" ? "ft" : "fq",
          queryType === "ean" ? `alternateIds_Ean:${term}` : queryType === "sku" ? `skuId:${term}` : term,
        );
        url.searchParams.set("_from", String(page * 50));
        url.searchParams.set("_to", String(page * 50 + 49));
        // The legacy storefront rejects '+' for spaces; it expects RFC 3986 encoding.
        endpoint = `${url.origin}${url.pathname}?${[...url.searchParams].map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&")}`;
        status = undefined;
        const response = await fetch(endpoint, {
          signal: controller.signal,
          redirect: "error",
          headers: {
            Accept: "application/json",
            "User-Agent": "farmacia-whatsapp-ai/1.0",
          },
        });
        status = response.status;
        if (!response.ok) throw new Error(`HTTP ${status}`);
        const body: unknown = await response.json();
        if (!Array.isArray(body))
          throw new Error("Unexpected catalog response");
        const pageSignature = JSON.stringify(body.map((row) => row?.productId));
        if (body.length && seenPages.has(pageSignature)) {
          failureReason = "repeated_page";
          break;
        }
        seenPages.add(pageSignature);
        const normalized = this.normalizeProducts(body);
        discardedTotals.noPrice += normalized.discarded.noPrice;
        discardedTotals.unavailable += normalized.discarded.unavailable;
        discardedTotals.quarantined += normalized.discarded.quarantined;
        for (const product of normalized.products) {
          const key = product.ean || product.skuId;
          const previous = products.get(key);
          if (!previous || product.price < previous.price)
            products.set(key, product);
        }
        this.logger.log(
          JSON.stringify({
            provider: this.name,
            term,
            endpoint,
            status,
            page,
            resultsFound: body.length,
            resultsAfterFilter: normalized.products.length,
            discarded: normalized.discarded,
          }),
        );
        await this.record({
          provider: this.name,
          operation: queryType === "name" ? "catalog_search" : `catalog_${queryType}_search`,
          query: term,
          endpoint,
          statusCode: status,
          durationMs: Date.now() - startedAt,
          resultsFound: body.length,
          resultsAfterFilter: normalized.products.length,
          outcome: normalized.products.length
            ? ProviderRequestOutcome.SUCCESS
            : ProviderRequestOutcome.EMPTY,
        });
        const range =
          response.headers.get("resources") ||
          response.headers.get("content-range");
        const total = range?.match(/\/(\d+)$/)?.[1];
        if (body.length < 50 || (total && (page + 1) * 50 >= Number(total))) {
          complete = true;
          break;
        }
      }
    } catch (error) {
      this.cooldownUntil = Date.now() + (status === 429 ? 300_000 : 30_000);
      const reason = controller.signal.aborted
        ? "timeout"
        : error instanceof Error
          ? error.message
          : "unknown error";
      failureReason = reason;
      this.logger.warn(
        JSON.stringify({
          provider: this.name,
          event: "PRECO POPULAR SEARCH FAILED",
          term,
          endpoint,
          status,
          reason,
        }),
      );
      await this.record({
        provider: this.name,
        operation: "catalog_search",
        query: term,
        endpoint,
        statusCode: status,
        durationMs: Date.now() - startedAt,
        outcome: ProviderRequestOutcome.FAILED,
        failureReason: reason,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!complete) this.logger.warn(JSON.stringify({ provider: this.name, term, reason: failureReason, complete: false }));
    const emptyReason = discardedTotals.quarantined ? "quarantined" : discardedTotals.unavailable ? "out_of_stock" : discardedTotals.noPrice ? "no_price" : undefined;
    return {
      products: [...products.values()],
      status: complete ? "ok" : products.size ? "incomplete" : "unavailable",
      failureReason: complete ? products.size ? undefined : emptyReason : failureReason,
    };
  }

  private normalizeProducts(body: unknown[]) {
    const products: CatalogProduct[] = [];
    const discarded = { invalid: 0, noPrice: 0, unavailable: 0, quarantined: 0 };
    for (const raw of body) {
      const parsed = productSchema.safeParse(raw);
      if (!parsed.success) {
        discarded.invalid += 1;
        continue;
      }
      const product = parsed.data;
      const activeIngredient = Object.entries(product).find(
        ([key]) => this.normalize(key) === "principio ativo",
      )?.[1];
      const ingredient =
        typeof activeIngredient === "string"
          ? activeIngredient
          : Array.isArray(activeIngredient)
            ? activeIngredient
                .filter((value) => typeof value === "string")
                .join("; ")
            : undefined;
      const isMedicine =
        (product.categories || []).some((category) =>
          /\/medicamentos?\//.test(this.normalize(category)),
        ) || Boolean(ingredient);
      for (const item of product.items) {
        const quarantine = CATALOG_QUARANTINE.find((entry) => entry.skuId === String(item.itemId) || entry.ean === item.ean);
        if (quarantine) {
          discarded.quarantined += 1;
          this.logger.warn(JSON.stringify({ provider: this.name, skuId: item.itemId, ean: item.ean, reason: quarantine.reason }));
          continue;
        }
        const priced = item.sellers.filter(
          (seller) => (seller.commertialOffer.Price ?? 0) > 0,
        );
        if (!priced.length) {
          discarded.noPrice += 1;
          continue;
        }
        const available = priced.filter(
          (seller) =>
            seller.commertialOffer.IsAvailable !== false &&
            (seller.commertialOffer.AvailableQuantity ?? 1) > 0,
        );
        if (!available.length) {
          discarded.unavailable += 1;
          continue;
        }
        available.sort(
          (a, b) =>
            Number(Boolean(b.sellerDefault)) -
              Number(Boolean(a.sellerDefault)) ||
            a.commertialOffer.Price! - b.commertialOffer.Price!,
        );
        const price = available[0].commertialOffer.Price!;
        // nameComplete can concatenate the full product and SKU names twice.
        let name = item.name || item.nameComplete || product.productName;
        if (this.normalize(name) === this.normalize(product.productName))
          name = product.productName;
        if (/^\d/.test(name) && !/^\d/.test(product.productName)) {
          name = `${this.selector.normalizeMedicineName(product.productName) || product.brand || product.productName} ${name}`;
        }
        const image = item.images?.find((entry) =>
          /^https:\/\//i.test(entry.imageUrl) &&
          !/\/(?:rotulo_pp_|Similar_Tarja|placeholder|sem[-_]?imagem)/i.test(entry.imageUrl),
        )?.imageUrl;
        products.push({
          skuId: String(item.itemId),
          name,
          brand: product.brand,
          ean: item.ean || undefined,
          category: product.categories?.[0]?.split("/").filter(Boolean).pop(),
          activeIngredient: ingredient,
          isMedicine,
          imageUrl: image,
          price,
          salePrice: calculatePrecoPopularSalePrice(price),
        });
      }
    }
    return { products, discarded };
  }

  private async record(
    input: Parameters<ProviderRequestLogService["record"]>[0],
  ) {
    try {
      await this.requestLog?.record(input);
    } catch {
      this.logger.warn("PRECO POPULAR: provider log unavailable");
    }
  }

  private cleanRetailQuery(query: string) {
    return this.normalize(query)
      .replace(/[?!:;]/g, " ")
      .replace(
        /^(?:ola\s+)?(?:tem|teria|quero|preciso|gostaria)(?:\s+(?:de|do|da|um|uma))?\s+/,
        "",
      )
      .replace(/\s+/g, " ")
      .trim();
  }

  private normalize(value: string) {
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }
}
