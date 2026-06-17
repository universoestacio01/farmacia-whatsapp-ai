import { Injectable } from "@nestjs/common";
import { RETAIL_PRODUCTS } from "../config/retail-products.config";
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
