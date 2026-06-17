import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { calculateRetailSalePrice } from "../config/retail-price-rules.config";
import { CosmosTokenPoolService } from "./cosmos-token-pool.service";
import {
  NormalizedRetailProduct,
  ProductProvider,
} from "./product-provider.interface";

class CosmosHttpError extends Error {
  constructor(readonly status: number) {
    super(`Cosmos respondeu ${status}`);
  }
}

interface CosmosCacheEntry {
  expiresAt: number;
  items: NormalizedRetailProduct[];
}

@Injectable()
export class CosmosService implements ProductProvider {
  readonly name = "cosmos" as const;
  private readonly logger = new Logger(CosmosService.name);
  private readonly cache = new Map<string, CosmosCacheEntry>();

  constructor(
    private readonly configService: ConfigService,
    private readonly tokenPool: CosmosTokenPoolService,
  ) {}

  async search(query: string): Promise<NormalizedRetailProduct[]> {
    const gtin = this.extractGtin(query);

    if (gtin) {
      const product = await this.findByGtin(gtin);
      return product ? [product] : [];
    }

    if (!this.isConfigured()) {
      this.logger.warn("COSMOS nao configurado, usando catalogo manual");
      return [];
    }

    const cacheKey = `name:${this.normalizeCacheKey(query)}`;
    const cached = this.getFromCache(cacheKey);

    if (cached) {
      return cached;
    }

    this.logger.log(`COSMOS SEARCH BY NAME: ${query}`);
    this.logger.log(`COSMOS QUERY: ${query}`);

    try {
      const items = await this.searchByName(query);
      this.logger.log(`COSMOS RESULTS FOUND: ${items.length}`);
      this.cacheSearchResult(cacheKey, items);
      return items;
    } catch (error) {
      this.logger.warn(
        `COSMOS FAILED, FALLING BACK TO MANUAL CATALOG: ${
          error instanceof Error ? error.message : "erro desconhecido"
        }`,
      );
      this.cacheFailure(cacheKey, error);
      return [];
    }
  }

  async findByGtin(gtin: string): Promise<NormalizedRetailProduct | null> {
    if (!this.isConfigured()) {
      this.logger.warn("COSMOS nao configurado, usando catalogo manual");
      return null;
    }

    const cacheKey = `gtin:${gtin}`;
    const cached = this.getFromCache(cacheKey);

    if (cached) {
      return cached[0] || null;
    }

    this.logger.log(`COSMOS SEARCH BY GTIN: ${gtin}`);

    try {
      const data = await this.fetchJson(`/gtins/${encodeURIComponent(gtin)}.json`);
      const product = this.normalizeItem(data);
      this.logger.log(`COSMOS RESULTS FOUND: ${product ? 1 : 0}`);
      this.cacheSearchResult(cacheKey, product ? [product] : []);
      return product;
    } catch (error) {
      this.logger.warn(
        `COSMOS FAILED, FALLING BACK TO MANUAL CATALOG: ${
          error instanceof Error ? error.message : "erro desconhecido"
        }`,
      );
      this.cacheFailure(cacheKey, error);
      return null;
    }
  }

  isConfigured() {
    return this.tokenPool.isConfigured();
  }

  tokenCount() {
    return this.tokenPool.tokenCount();
  }

  private async searchByName(query: string) {
    const endpoints = [
      `/products.json?query=${encodeURIComponent(query)}`,
      `/products/search.json?query=${encodeURIComponent(query)}`,
      `/gtins/search.json?query=${encodeURIComponent(query)}`,
      `/gtins.json?query=${encodeURIComponent(query)}`,
    ];
    let rateLimitError: CosmosHttpError | null = null;

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
        if (error instanceof CosmosHttpError && error.status === 429) {
          rateLimitError = error;
        }

        this.logger.warn(
          `Cosmos busca por nome falhou em ${endpoint}: ${
            error instanceof Error ? error.message : "erro desconhecido"
          }`,
        );
      }
    }

    if (rateLimitError) {
      throw rateLimitError;
    }

    return [];
  }

  private async fetchJson(endpoint: string) {
    const tokenSelection = this.tokenPool.selectToken();

    if (!tokenSelection) {
      throw new Error("Cosmos sem token disponivel");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const response = await fetch(`${this.getBaseUrl()}${endpoint}`, {
        headers: {
          "X-Cosmos-Token": tokenSelection.token,
          "User-Agent":
            this.configService.get<string>("COSMOS_USER_AGENT") ||
            "farmacia-whatsapp-ai",
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        signal: controller.signal,
      });

      if (response.status === 429) {
        this.tokenPool.markRateLimited(tokenSelection.index);
        throw new CosmosHttpError(response.status);
      }

      if ([401, 403].includes(response.status)) {
        this.tokenPool.markInvalid(tokenSelection.index);
        throw new CosmosHttpError(response.status);
      }

      if ([500, 503].includes(response.status)) {
        throw new CosmosHttpError(response.status);
      }

      if (!response.ok) {
        throw new CosmosHttpError(response.status);
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
    const baseProduct = {
      productName: description,
      displayName: description,
      description,
      brand,
      category:
        this.nestedString(item, "gpc", ["description"]) ||
        this.nestedString(item, "category", ["description"]) ||
        this.firstString(item, ["category"]),
      gpcDescription: this.nestedString(item, "gpc", ["description"]),
      avgPrice,
      maxPrice,
      referencePrice,
    };
    const salePrice = calculateRetailSalePrice(
      baseProduct,
      this.getPositiveNumber("COSMOS_PRICE_MULTIPLIER", 1),
    );

    return {
      source: "cosmos",
      sourceId: this.firstString(item, ["id", "gtin", "ean"]),
      gtin: this.firstString(item, ["gtin"]),
      ean: this.firstString(item, ["gtin", "ean"]),
      productName: baseProduct.productName,
      displayName: baseProduct.displayName,
      description: baseProduct.description,
      brand,
      manufacturer: this.firstString(item, ["manufacturer", "fabricante"]),
      category: baseProduct.category,
      gpcDescription: baseProduct.gpcDescription,
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
      salePrice: salePrice.price,
      salePriceSource: salePrice.source,
      grossWeight: this.firstNumber(item, ["gross_weight"]),
      netWeight: this.firstNumber(item, ["net_weight"]),
      width: this.firstNumber(item, ["width"]),
      height: this.firstNumber(item, ["height"]),
      length: this.firstNumber(item, ["length"]),
      raw,
    };
  }

  private getFromCache(cacheKey: string) {
    const entry = this.cache.get(cacheKey);

    if (!entry) {
      this.logger.log("COSMOS CACHE MISS");
      return null;
    }

    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(cacheKey);
      this.logger.log("COSMOS CACHE MISS");
      return null;
    }

    this.logger.log("COSMOS CACHE HIT");
    return entry.items.map((item) => ({ ...item }));
  }

  private cacheSearchResult(cacheKey: string, items: NormalizedRetailProduct[]) {
    const hasPricedResult = items.some(
      (item) => item.salePrice !== undefined && item.salePrice > 0,
    );
    const ttlHours = hasPricedResult
      ? this.getPositiveNumber("COSMOS_CACHE_TTL_HOURS", 24)
      : 1;

    this.cache.set(cacheKey, {
      expiresAt: Date.now() + ttlHours * 60 * 60 * 1000,
      items: items.map((item) => ({ ...item })),
    });
  }

  private cacheFailure(cacheKey: string, error: unknown) {
    const isRateLimit =
      error instanceof CosmosHttpError && error.status === 429;
    const ttlMinutes = isRateLimit
      ? this.getPositiveNumber("COSMOS_TOKEN_429_COOLDOWN_MINUTES", 30)
      : 5;

    this.cache.set(cacheKey, {
      expiresAt: Date.now() + ttlMinutes * 60 * 1000,
      items: [],
    });
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

  private normalizeCacheKey(value: string) {
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^\w]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private getPositiveNumber(key: string, fallback: number) {
    const value = Number(this.configService.get<number | string>(key) ?? fallback);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  private getBaseUrl() {
    return (
      this.configService.get<string>("COSMOS_API_BASE_URL") ||
      "https://api.cosmos.bluesoft.com.br"
    ).replace(/\/$/, "");
  }
}
