import { Injectable, Logger } from "@nestjs/common";
import { calculateRetailSalePrice } from "../config/retail-price-rules.config";
import { formatProductDisplayName } from "../whatsapp/whatsapp-copy";
import { CommercialMedicineOption } from "./bula-api.service";
import { CosmosService } from "./cosmos.service";
import { ManualRetailProductService } from "./manual-retail-product.service";
import { NormalizedRetailProduct } from "./product-provider.interface";

export interface RetailProductLookupSummary {
  query: string;
  options: CommercialMedicineOption[];
  manualFallback: boolean;
  category?: string;
  requestedBrand?: string;
}

@Injectable()
export class ProductSearchOrchestratorService {
  private readonly logger = new Logger(ProductSearchOrchestratorService.name);

  constructor(
    private readonly cosmosService: CosmosService,
    private readonly manualRetailProductService: ManualRetailProductService,
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

    const gtin = this.extractGtin(query);
    const category = this.findCategoryForQuery(query);
    const requestedBrand = this.findRequestedBrand(query, category);
    const allowKits = this.allowsKits(query);
    let products: NormalizedRetailProduct[] = [];

    if (category && this.isGenericCategoryQuery(query, category) && !requestedBrand) {
      const manualProducts = await this.getManualFallbackProducts(
        query,
        category,
        requestedBrand,
      );

      return {
        query,
        category,
        requestedBrand: undefined,
        options: this.toCommercialOptions(manualProducts).slice(0, 3),
        manualFallback: true,
      };
    }

    try {
      if (gtin) {
        const product = await this.cosmosService.findByGtin(gtin);
        products = product ? [product] : [];
      } else {
        products = await this.cosmosService.search(query);
      }
    } catch (error) {
      this.logger.warn(
        `COSMOS FAILED, FALLING BACK TO MANUAL CATALOG: ${
          error instanceof Error ? error.message : "erro desconhecido"
        }`,
      );
      products = [];
    }

    this.logger.log(`COSMOS RAW RESULTS COUNT: ${products.length}`);

    if (products.length > 0) {
      let selectedProducts = this.selectCommercialProducts(products, {
        query,
        category,
        requestedBrand,
        allowKits,
      });
      let manualFallback = false;

      if (selectedProducts.length === 0 && category) {
        this.logger.warn("COSMOS FALLING BACK TO MANUAL CATALOG");
        selectedProducts = await this.getManualFallbackProducts(
          query,
          category,
          requestedBrand,
        );
        manualFallback = true;
      }

      return {
        query,
        category: category || undefined,
        requestedBrand: requestedBrand || undefined,
        options: this.toCommercialOptions(selectedProducts).slice(0, 3),
        manualFallback,
      };
    }

    this.logger.warn("COSMOS FALLING BACK TO MANUAL CATALOG");
    const manualProducts = await this.getManualFallbackProducts(
      query,
      category,
      requestedBrand,
    );

    return {
      query,
      category: category || undefined,
      requestedBrand: requestedBrand || undefined,
      options: this.toCommercialOptions(manualProducts).slice(0, 3),
      manualFallback: true,
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
    this.logger.log(`COSMOS RESULTS AFTER FILTER: ${filtered.length}`);

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
      const salePrice =
        product.salePrice !== undefined && product.salePrice > 0
          ? {
              price: product.salePrice,
              source: product.salePriceSource || "default_category_price",
            }
          : calculateRetailSalePrice(product);
      this.logger.log(`RETAIL PRICE SOURCE: ${salePrice.source}`);
      this.logger.log(`RETAIL FINAL PRICE: ${salePrice.price}`);

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
        pricePf: salePrice.price,
        selectionReason: `fonte ${product.source}`,
        brand: product.brand,
        description: product.description || product.displayName,
        imageUrl: product.imageUrl || product.thumbnailUrl,
        source: product.source,
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

  private isGenericCategoryQuery(query: string, category: string) {
    const normalizedQuery = this.normalize(query)
      .replace(/[?!.:,;]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const normalizedCategory = this.normalize(category);

    return normalizedQuery === normalizedCategory;
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

  private async getManualFallbackProducts(
    query: string,
    category: string | null,
    requestedBrand: string | null,
  ) {
    if (category) {
      if (!requestedBrand || this.manualRetailProductService.isAnyBrandReply(requestedBrand)) {
        return this.manualRetailProductService.search(category);
      }

      return [
        this.manualRetailProductService.createManualProduct(
          query,
          category,
          requestedBrand || undefined,
        ),
      ];
    }

    return [];
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

  private normalize(value: string) {
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }
}
