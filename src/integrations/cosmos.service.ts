import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  NormalizedRetailProduct,
  ProductProvider,
} from "./product-provider.interface";

@Injectable()
export class CosmosService implements ProductProvider {
  readonly name = "cosmos" as const;
  private readonly logger = new Logger(CosmosService.name);

  constructor(private readonly configService: ConfigService) {}

  async search(query: string): Promise<NormalizedRetailProduct[]> {
    const gtin = this.extractGtin(query);

    if (gtin) {
      const product = await this.findByGtin(gtin);
      return product ? [product] : [];
    }

    if (!this.isConfigured()) {
      this.logger.warn("COSMOS_API_TOKEN ausente, usando catalogo manual");
      return [];
    }

    this.logger.log(`COSMOS SEARCH BY NAME: ${query}`);

    try {
      const items = await this.searchByName(query);
      this.logger.log(`COSMOS RESULTS FOUND: ${items.length}`);
      return items;
    } catch (error) {
      this.logger.warn(
        `COSMOS FAILED, FALLING BACK TO MANUAL CATALOG: ${
          error instanceof Error ? error.message : "erro desconhecido"
        }`,
      );
      return [];
    }
  }

  async findByGtin(gtin: string): Promise<NormalizedRetailProduct | null> {
    if (!this.isConfigured()) {
      this.logger.warn("COSMOS_API_TOKEN ausente, usando catalogo manual");
      return null;
    }

    this.logger.log(`COSMOS SEARCH BY GTIN: ${gtin}`);

    try {
      const data = await this.fetchJson(`/gtins/${encodeURIComponent(gtin)}.json`);
      const product = this.normalizeItem(data);
      this.logger.log(`COSMOS RESULTS FOUND: ${product ? 1 : 0}`);
      return product;
    } catch (error) {
      this.logger.warn(
        `COSMOS FAILED, FALLING BACK TO MANUAL CATALOG: ${
          error instanceof Error ? error.message : "erro desconhecido"
        }`,
      );
      return null;
    }
  }

  isConfigured() {
    return Boolean(this.configService.get<string>("COSMOS_API_TOKEN")?.trim());
  }

  private async searchByName(query: string) {
    const endpoints = [
      `/products.json?query=${encodeURIComponent(query)}`,
      `/products/search.json?query=${encodeURIComponent(query)}`,
      `/gtins/search.json?query=${encodeURIComponent(query)}`,
      `/gtins.json?query=${encodeURIComponent(query)}`,
    ];

    for (const endpoint of endpoints) {
      try {
        const data = await this.fetchJson(endpoint);
        const items = this.extractItems(data)
          .map((item) => this.normalizeItem(item))
          .filter((item): item is NormalizedRetailProduct => Boolean(item));

        if (items.length > 0) {
          return items;
        }
      } catch (error) {
        this.logger.warn(
          `Cosmos busca por nome falhou em ${endpoint}: ${
            error instanceof Error ? error.message : "erro desconhecido"
          }`,
        );
      }
    }

    return [];
  }

  private async fetchJson(endpoint: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const response = await fetch(`${this.getBaseUrl()}${endpoint}`, {
        headers: {
          "X-Cosmos-Token": this.configService.get<string>("COSMOS_API_TOKEN") || "",
          "User-Agent":
            this.configService.get<string>("COSMOS_USER_AGENT") ||
            "farmacia-whatsapp-ai",
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        signal: controller.signal,
      });

      if ([401, 403, 429, 500, 503].includes(response.status)) {
        throw new Error(`Cosmos respondeu ${response.status}`);
      }

      if (!response.ok) {
        throw new Error(`Cosmos respondeu ${response.status}`);
      }

      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  private normalizeItem(raw: unknown): NormalizedRetailProduct | null {
    if (!raw || typeof raw !== "object") {
      return null;
    }

    const item = raw as Record<string, unknown>;
    const description = this.firstString(item, [
      "description",
      "descricao",
      "name",
      "product_name",
    ]);

    if (!description) {
      return null;
    }

    const brand = this.nestedString(item, "brand", ["name"]);
    const thumbnailUrl = this.firstString(item, ["thumbnail", "thumbnail_url"]);
    const brandPicture = this.nestedString(item, "brand", ["picture"]);
    const avgPrice = this.firstNumber(item, ["avg_price", "avgPrice"]);
    const maxPrice = this.firstNumber(item, ["max_price", "maxPrice"]);
    const referencePrice = this.firstNumber(item, ["price", "preco"]);

    return {
      source: "cosmos",
      sourceId: this.firstString(item, ["id", "gtin", "ean"]),
      gtin: this.firstString(item, ["gtin"]),
      ean: this.firstString(item, ["gtin", "ean"]),
      productName: description,
      displayName: description,
      description,
      brand,
      manufacturer: this.firstString(item, ["manufacturer", "fabricante"]),
      category:
        this.nestedString(item, "gpc", ["description"]) ||
        this.firstString(item, ["category"]),
      gpcDescription: this.nestedString(item, "gpc", ["description"]),
      ncmCode: this.nestedString(item, "ncm", ["code"]),
      ncmDescription: this.nestedString(item, "ncm", [
        "full_description",
        "description",
      ]),
      imageUrl: thumbnailUrl || brandPicture,
      thumbnailUrl,
      avgPrice,
      maxPrice,
      referencePrice,
      salePrice: this.calculateSalePrice(avgPrice, maxPrice, referencePrice),
      grossWeight: this.firstNumber(item, ["gross_weight"]),
      netWeight: this.firstNumber(item, ["net_weight"]),
      width: this.firstNumber(item, ["width"]),
      height: this.firstNumber(item, ["height"]),
      length: this.firstNumber(item, ["length"]),
      raw,
    };
  }

  private calculateSalePrice(
    avgPrice?: number,
    maxPrice?: number,
    referencePrice?: number,
  ) {
    const basePrice = [avgPrice, maxPrice, referencePrice].find(
      (price) => price !== undefined && price > 0,
    );

    if (basePrice === undefined) {
      return undefined;
    }

    const multiplier = Number(
      this.configService.get<number | string>("COSMOS_PRICE_MULTIPLIER") ?? 1,
    );
    const safeMultiplier =
      Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;

    return Number((basePrice * safeMultiplier).toFixed(2));
  }

  private extractItems(data: unknown): unknown[] {
    if (Array.isArray(data)) {
      return data;
    }

    if (!data || typeof data !== "object") {
      return [];
    }

    const record = data as Record<string, unknown>;

    for (const key of ["data", "items", "products", "gtins", "results"]) {
      const value = record[key];

      if (Array.isArray(value)) {
        return value;
      }
    }

    return [];
  }

  private firstString(record: Record<string, unknown>, keys: string[]) {
    for (const key of keys) {
      const value = record[key];

      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }

      if (typeof value === "number") {
        return String(value);
      }
    }

    return undefined;
  }

  private firstNumber(record: Record<string, unknown>, keys: string[]) {
    for (const key of keys) {
      const value = record[key];

      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }

      if (typeof value === "string") {
        const normalized = Number(
          value.replace(/[^\d,.-]/g, "").replace(",", "."),
        );

        if (Number.isFinite(normalized)) {
          return normalized;
        }
      }
    }

    return undefined;
  }

  private nestedString(
    record: Record<string, unknown>,
    key: string,
    fields: string[],
  ) {
    const value = record[key];

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }

    return this.firstString(value as Record<string, unknown>, fields);
  }

  private extractGtin(query: string) {
    const digits = query.replace(/\D/g, "");
    return [8, 12, 13, 14].includes(digits.length) ? digits : null;
  }

  private getBaseUrl() {
    return (
      this.configService.get<string>("COSMOS_API_BASE_URL") ||
      "https://api.cosmos.bluesoft.com.br"
    ).replace(/\/$/, "");
  }
}
