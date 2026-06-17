import { Injectable } from "@nestjs/common";
import {
  RETAIL_PRODUCTS,
  RetailProductConfig,
} from "../config/retail-products.config";
import {
  NormalizedRetailProduct,
  ProductProvider,
} from "./product-provider.interface";

@Injectable()
export class ManualRetailProductService implements ProductProvider {
  readonly name = "manual_catalog" as const;

  async search(query: string): Promise<NormalizedRetailProduct[]> {
    const key = this.findCatalogKey(query);

    if (!key) {
      return [];
    }

    return RETAIL_PRODUCTS[key].options.map((option, index) => ({
      source: "manual_catalog",
      sourceId: `${key}:${index + 1}`,
      productName: option.productName,
      displayName: option.displayName,
      description: option.description,
      brand: option.brand,
      category: option.category,
      raw: option,
    }));
  }

  async findByGtin(): Promise<NormalizedRetailProduct | null> {
    return null;
  }

  findCatalogKey(query: string) {
    const normalized = this.normalize(query);

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
    const normalized = this.normalize(query)
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

    const normalized = this.normalize(reply).trim();
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

    return brand || reply.trim();
  }

  isAnyBrandReply(reply: string) {
    const normalized = this.normalize(reply).trim();
    return /^(qualquer|qualquer marca|tanto faz|sem preferencia|sem preferencia de marca)$/.test(
      normalized,
    );
  }

  isRetailProductQuery(query: string) {
    return Boolean(this.findCatalogKey(query) || this.extractGtin(query));
  }

  private extractGtin(query: string) {
    const digits = query.replace(/\D/g, "");
    return [8, 12, 13, 14].includes(digits.length) ? digits : null;
  }

  private hasWordOrPhrase(text: string, phrase: string) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|\\b)${escaped}(\\b|$)`).test(text);
  }

  private normalize(value: string) {
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }
}
