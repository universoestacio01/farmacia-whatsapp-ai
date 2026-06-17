import { Injectable, Logger } from "@nestjs/common";
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
  noPricedResults?: boolean;
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
      const selectedProducts = this.selectCommercialProducts(products, {
        query,
        category,
        requestedBrand,
        allowKits,
      });

      return {
        query,
        category: category || undefined,
        requestedBrand: requestedBrand || undefined,
        options: this.toCommercialOptions(selectedProducts).slice(0, 3),
        manualFallback: false,
        noPricedResults: selectedProducts.length === 0,
      };
    }

    this.logger.warn("COSMOS FALLING BACK TO MANUAL CATALOG");

    return {
      query,
      category: category || undefined,
      requestedBrand: requestedBrand || undefined,
      options: [],
      manualFallback: true,
      noPricedResults: true,
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
    const withPrice = products.filter(
      (product) => product.salePrice !== undefined && product.salePrice > 0,
    );
    this.logger.log(`COSMOS RESULTS WITH PRICE: ${withPrice.length}`);

    const filtered = withPrice.filter((product) =>
      this.isQualityRetailProduct(product, context),
    );
    this.logger.log(`COSMOS RESULTS AFTER FILTER: ${filtered.length}`);

    if (filtered.length === 0) {
      this.logger.warn("COSMOS NO PRICED RESULTS");
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
    return products.map((product, index) => ({
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
      pricePf: product.salePrice,
      selectionReason: `fonte ${product.source}`,
      brand: product.brand,
      description: product.description || product.displayName,
      imageUrl: product.imageUrl || product.thumbnailUrl,
      source: product.source,
    }));
  }

  private formatLabel(product: NormalizedRetailProduct) {
    const label = product.displayName || product.productName;
    return label.replace(/\s+/g, " ").trim();
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
      null
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

  private normalize(value: string) {
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }
}
