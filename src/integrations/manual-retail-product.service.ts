import { Injectable } from "@nestjs/common";
import { calculateRetailSalePrice } from "../config/retail-price-rules.config";
import {
  RETAIL_PRODUCTS,
  RetailProductConfig,
} from "../config/retail-products.config";
import {
  NormalizedRetailProduct,
  ProductProvider,
} from "./product-provider.interface";
import { explicitRetailCategory, extractRetailGtin, normalizeRetailSearchQuery, normalizeRetailTerms, retailTextContains } from "../utils/retail-search-query.util";

@Injectable()
export class ManualRetailProductService implements ProductProvider {
  readonly name = "manual_catalog" as const;

  async search(query: string): Promise<NormalizedRetailProduct[]> {
    const key = this.findCatalogKey(query);

    if (!key) {
      return [];
    }

    return RETAIL_PRODUCTS[key].options.map((option, index) => {
      const salePrice = calculateRetailSalePrice(option);

      return {
        source: "manual_catalog",
        sourceId: `${key}:${index + 1}`,
        productName: option.productName,
        displayName: option.displayName,
        description: option.description,
        brand: option.brand,
        category: option.category,
        salePrice: salePrice.price,
        salePriceSource: salePrice.source,
        raw: option,
      };
    });
  }

  createManualProduct(query: string, category: string, brand?: string) {
    const displayName = this.formatManualDisplayName(category, brand, query);
    const product: NormalizedRetailProduct = {
      source: "manual_catalog",
      sourceId: `manual:${this.normalize(displayName).replace(/\s+/g, "-")}`,
      productName: displayName,
      displayName,
      description: displayName,
      brand,
      category,
      raw: { query, category, brand },
    };
    const salePrice = calculateRetailSalePrice(product);

    return {
      ...product,
      salePrice: salePrice.price,
      salePriceSource: salePrice.source,
    };
  }

  async findByGtin(): Promise<NormalizedRetailProduct | null> {
    return null;
  }

  findCatalogKey(query: string) {
    const normalized = normalizeRetailSearchQuery(query);
    const explicitCategory = explicitRetailCategory(normalized);
    if (explicitCategory) return explicitCategory;

    for (const [key, config] of Object.entries(RETAIL_PRODUCTS)) {
      if (
        config.aliases.some((alias) =>
          this.hasWordOrPhrase(normalized, this.normalize(alias)),
        )
      ) {
        return key;
      }
    }

    return null;
  }

  findGenericCategory(query: string) {
    const normalized = normalizeRetailSearchQuery(query)
      .replace(/[?!.:,;]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    for (const [key, config] of Object.entries(RETAIL_PRODUCTS)) {
      const aliases = [key, ...config.aliases].map((alias) =>
        this.normalize(alias),
      );

      if (aliases.includes(normalized)) {
        return key;
      }
    }

    return null;
  }

  getCategoryConfig(category: string): RetailProductConfig | null {
    return RETAIL_PRODUCTS[category] || null;
  }

  getPopularBrands(category: string) {
    return RETAIL_PRODUCTS[category]?.popularBrands || [];
  }

  resolveBrandSelection(category: string, reply: string) {
    const config = RETAIL_PRODUCTS[category];

    if (!config) {
      return null;
    }

    const normalized = normalizeRetailSearchQuery(reply);
    const numberMatch = normalized.match(/^\d+$/);

    if (numberMatch) {
      const index = Number(numberMatch[0]) - 1;
      const visibleBrandCount = Math.min(config.popularBrands.length, 5);

      if (index === visibleBrandCount) {
        return "qualquer marca";
      }

      return config.popularBrands.slice(0, visibleBrandCount)[index] || null;
    }

    if (this.isAnyBrandReply(reply)) {
      return "qualquer marca";
    }

    const brand = config.popularBrands.find(
      (candidate) => this.normalize(candidate) === normalized,
    );

    return brand || normalized;
  }

  isAnyBrandReply(reply: string) {
    const normalized = this.normalize(reply).trim();
    return /^(qualquer|qualquer marca|tanto faz|sem preferencia|sem preferencia de marca)$/.test(
      normalized,
    );
  }

  extractBrandFromQuery(category: string, query: string) {
    const brands = [...new Set([
      ...(RETAIL_PRODUCTS[category]?.popularBrands || []),
      ...Object.values(RETAIL_PRODUCTS).flatMap((config) => config.popularBrands),
      "Gillette", "Kérastase",
    ])].sort((a, b) => b.length - a.length);
    // Unknown text can be a volume, model, variant or an unknown brand. Keep it
    // in the query, but do not turn the entire suffix into a mandatory brand.
    return brands.find((brand) => retailTextContains(query, brand)) || null;
  }

  isRetailProductQuery(query: string) {
    return Boolean(this.findCatalogKey(query) || extractRetailGtin(query));
  }

  private hasWordOrPhrase(text: string, phrase: string) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|\\b)${escaped}(\\b|$)`).test(text);
  }

  private normalize(value: string) {
    return normalizeRetailTerms(value);
  }

  private formatManualDisplayName(
    category: string,
    brand: string | undefined,
    query: string,
  ) {
    const categoryLabel = category
      .replace(/_/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase());

    if (brand?.trim()) {
      return `${categoryLabel} ${brand.trim()}`;
    }

    return query
      .trim()
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }
}
