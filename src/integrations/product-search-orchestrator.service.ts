import { Injectable, Logger } from "@nestjs/common";
import { CommercialMedicineOption } from "./bula-api.service";
import { CosmosService } from "./cosmos.service";
import { ManualRetailProductService } from "./manual-retail-product.service";
import { NormalizedRetailProduct } from "./product-provider.interface";

export interface RetailProductLookupSummary {
  query: string;
  options: CommercialMedicineOption[];
  manualFallback: boolean;
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

  async searchProducts(query: string): Promise<RetailProductLookupSummary> {
    this.logger.log("PRODUCT INTENT DETECTED");
    this.logger.log(`RETAIL PRODUCT QUERY: ${query}`);

    const gtin = this.extractGtin(query);
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

    if (products.length > 0) {
      return {
        query,
        options: this.toCommercialOptions(products).slice(0, 3),
        manualFallback: products.every((product) => product.salePrice === undefined),
      };
    }

    const manualProducts = await this.manualRetailProductService.search(query);

    return {
      query,
      options: this.toCommercialOptions(manualProducts).slice(0, 3),
      manualFallback: true,
    };
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
}
