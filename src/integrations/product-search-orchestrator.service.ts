import { Injectable, Logger } from "@nestjs/common";
import { formatProductDisplayName } from "../whatsapp/whatsapp-copy";
import { CommercialMedicineOption } from "./bula-api.service";
import { ManualRetailProductService } from "./manual-retail-product.service";
import { NormalizedRetailProduct } from "./product-provider.interface";
import { PrecoPopularService } from "./preco-popular.service";
import { CATALOG_PRICE_POLICY } from "../config/preco-popular.config";

export interface RetailProductLookupSummary {
  query: string;
  options: CommercialMedicineOption[];
  manualFallback: boolean;
  category?: string;
  requestedBrand?: string;
}

interface RetailCacheEntry {
  expiresAt: number;
  value: RetailProductLookupSummary;
}

@Injectable()
export class ProductSearchOrchestratorService {
  private readonly logger = new Logger(ProductSearchOrchestratorService.name);
  private readonly cache = new Map<string, RetailCacheEntry>();

  constructor(
    private readonly manualRetailProductService: ManualRetailProductService,
    private readonly precoPopularService: PrecoPopularService,
  ) {}

  isRetailProductQuery(message: string) {
    return this.manualRetailProductService.isRetailProductQuery(message);
  }

  findGenericCategory(query: string) {
    return this.manualRetailProductService.findGenericCategory(query);
  }

  getPopularBrands(category: string) {
    return this.manualRetailProductService.getPopularBrands(category);
  }

  resolveBrandSelection(category: string, reply: string) {
    return this.manualRetailProductService.resolveBrandSelection(category, reply);
  }

  isAnyBrandReply(reply: string) {
    return this.manualRetailProductService.isAnyBrandReply(reply);
  }

  async searchProducts(query: string): Promise<RetailProductLookupSummary> {
    this.logger.log("PRODUCT INTENT DETECTED");
    this.logger.log(`RETAIL PRODUCT QUERY: ${query}`);
    const cacheKey = this.normalize(query);
    const cached = this.getFromCache(cacheKey);

    if (cached) {
      return cached;
    }

    const gtin = this.extractGtin(query);
    const category = this.findCategoryForQuery(query);
    const requestedBrand = this.findRequestedBrand(query, category);
    const allowKits = this.allowsKits(query);
    if (this.precoPopularService?.isEnabled()) {
      try {
        const catalogProducts = gtin
          ? [await this.precoPopularService.findRetailByGtin(gtin)].filter((product): product is NormalizedRetailProduct => product !== null)
          : await this.precoPopularService.searchRetail(query);
        const selected = this.selectCommercialProducts(catalogProducts, {
          query, category, requestedBrand, allowKits,
        });
        if (selected.length) {
          const summary = {
            query, category: category || undefined,
            requestedBrand: requestedBrand || undefined,
            options: this.toCommercialOptions(selected).slice(0, 3),
            manualFallback: false,
          };
          this.setCache(cacheKey, summary, 300);
          return summary;
        }
      } catch (error) {
        this.logger.warn(`PRECO POPULAR RETAIL SEARCH FAILED: ${error instanceof Error ? error.message : "erro desconhecido"}`);
      }
    }

    return {
      query,
      category: category || undefined,
      requestedBrand: requestedBrand || undefined,
      options: [],
      manualFallback: false,
    };
  }

  buildQueryFromBrandSelection(category: string, brand: string) {
    return this.manualRetailProductService.isAnyBrandReply(brand)
      ? category
      : `${category} ${brand}`;
  }

  private selectCommercialProducts(
    products: NormalizedRetailProduct[],
    context: {
      query: string;
      category: string | null;
      requestedBrand: string | null;
      allowKits: boolean;
    },
  ) {
    const filtered = products.filter((product) =>
      this.isQualityRetailProduct(product, context),
    );
    this.logger.log(`RETAIL RESULTS AFTER FILTER: ${filtered.length}`);

    if (filtered.length === 0) {
      return [];
    }

    return filtered
      .map((product) => ({
        product,
        score: this.scoreProduct(product, context),
      }))
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.product);
  }

  private isQualityRetailProduct(
    product: NormalizedRetailProduct,
    context: {
      query: string;
      category: string | null;
      requestedBrand: string | null;
      allowKits: boolean;
    },
  ) {
    const text = this.normalize(
      [
        product.displayName,
        product.productName,
        product.description,
        product.brand,
        product.category,
      ]
        .filter(Boolean)
        .join(" "),
    );

    if (product.source !== "preco_popular" || !Number.isFinite(product.salePrice) || (product.salePrice ?? 0) <= 0) return false;

    if (!product.displayName?.trim() && !product.productName?.trim()) {
      return false;
    }

    if (!context.allowKits && this.looksLikeKit(text)) {
      return false;
    }

    if (context.category && !this.matchesCategory(text, context.category)) {
      return false;
    }

    if (
      context.requestedBrand &&
      !text.includes(this.normalize(context.requestedBrand))
    ) {
      return false;
    }

    return text.length <= 180;
  }

  private scoreProduct(
    product: NormalizedRetailProduct,
    context: {
      category: string | null;
      requestedBrand: string | null;
      allowKits: boolean;
    },
  ) {
    const text = this.normalize(
      [product.displayName, product.productName, product.description, product.brand]
        .filter(Boolean)
        .join(" "),
    );
    let score = 0;

    if (context.requestedBrand && text.includes(this.normalize(context.requestedBrand))) {
      score += 40;
    }

    if (context.category && this.matchesCategory(text, context.category)) {
      score += 25;
    }

    if (this.hasCommonSize(text)) {
      score += 15;
    }

    if (product.imageUrl || product.thumbnailUrl) {
      score += 5;
    }

    if (!context.allowKits && !this.looksLikeKit(text)) {
      score += 10;
    }

    score += Math.max(0, 20 - text.length / 8);

    return score;
  }

  private toCommercialOptions(
    products: NormalizedRetailProduct[],
  ): CommercialMedicineOption[] {
    return products.map((product, index) => {
      const salePrice = product.salePrice!;
      this.logger.log("RETAIL PRICE SOURCE: preco_popular");
      this.logger.log(`RETAIL FINAL PRICE: ${salePrice}`);

      return {
        optionId: index + 1,
        productId: this.toNumericId(product.sourceId || product.gtin, index + 1),
        presentationId: this.toNumericId(
          product.sourceId || product.gtin,
          index + 1,
        ),
        type: "retail_product",
        productName: product.productName,
        medicineName: product.category || product.productName,
        label: this.formatLabel(product),
        formGroup: "produto",
        packageDescription: product.description,
        pricePf: salePrice,
        pricePolicy: CATALOG_PRICE_POLICY,
        selectionReason: `fonte ${product.source}`,
        brand: product.brand,
        description: product.description || product.displayName,
        imageUrl: product.imageUrl || product.thumbnailUrl,
        source: product.source,
        ean: product.ean || product.gtin,
        sourceId: product.sourceId,
      };
    });
  }

  private formatLabel(product: NormalizedRetailProduct) {
    const label = product.displayName || product.productName;
    return formatProductDisplayName(label.replace(/\s+/g, " ").trim());
  }

  private findCategoryForQuery(query: string) {
    const genericCategory =
      this.manualRetailProductService.findGenericCategory(query);

    if (genericCategory) {
      return genericCategory;
    }

    const key = this.manualRetailProductService.findCatalogKey(query);
    return key || null;
  }

  private findRequestedBrand(query: string, category: string | null) {
    if (!category) {
      return null;
    }

    const brands = this.manualRetailProductService.getPopularBrands(category);
    const normalizedQuery = this.normalize(query);

    return (
      brands.find((brand) => normalizedQuery.includes(this.normalize(brand))) ||
      this.manualRetailProductService.extractBrandFromQuery(category, query)
    );
  }

  private allowsKits(query: string) {
    return /\b(kit|combo|promocao|promocao|leve 2|conjunto)\b/.test(
      this.normalize(query),
    );
  }

  private looksLikeKit(text: string) {
    return /\b(kit|combo|leve|pack|conjunto)\b/.test(text) || /\+/.test(text);
  }

  private matchesCategory(text: string, category: string) {
    const normalizedCategory = this.normalize(category);

    if (normalizedCategory === "gillette") {
      return /\b(gillette|gilete|prestobarba|barbear|lamina)\b/.test(text);
    }

    if (normalizedCategory === "creme dental") {
      return /\b(creme dental|pasta de dente|dental|colgate|oral b|sensodyne|closeup)\b/.test(
        text,
      );
    }

    if (normalizedCategory === "lenco umedecido") {
      return /\b(lenco|lenço|toalha umedecida|umedecido)\b/.test(text);
    }

    return text.includes(normalizedCategory);
  }

  private hasCommonSize(text: string) {
    return /\b(90g|200ml|250ml|325ml|350ml|400ml|500ml|30ml|60ml|175ml)\b/.test(
      text,
    );
  }

  private toNumericId(value: string | undefined, fallback: number) {
    if (!value) {
      return fallback;
    }

    const numeric = Number(value);

    if (Number.isFinite(numeric)) {
      return numeric;
    }

    return (
      Math.abs(
        [...value].reduce((hash, char) => {
          return (hash << 5) - hash + char.charCodeAt(0);
        }, 0),
      ) || fallback
    );
  }

  private extractGtin(query: string) {
    const digits = query.replace(/\D/g, "");
    return [8, 12, 13, 14].includes(digits.length) ? digits : null;
  }

  private getFromCache(key: string) {
    const cached = this.cache.get(key);

    if (!cached || cached.expiresAt < Date.now()) {
      this.cache.delete(key);
      return null;
    }

    return cached.value;
  }

  private setCache(
    key: string,
    value: RetailProductLookupSummary,
    ttlSeconds: number,
  ) {
    if (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  private normalize(value: string) {
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }
}
