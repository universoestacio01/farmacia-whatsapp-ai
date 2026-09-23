import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CommercialMedicineSelector } from "./commercial-medicine-selector";
import {
  MedicineProvider,
  NormalizedMedicineOption,
} from "./medicine-provider.interface";
import { PharmaDbAuthService } from "./pharmadb-auth.service";
import { backupEnabled, PHARMADB_BASE_URL } from "../config/medicine-backups.config";
import { sanitizeEnv } from "../config/env-sanitize";
import { extractMedicineStrengths, removeMedicineStrengths } from "../utils/medicine-strength.util";
import { providerFailure } from "../utils/provider-failure.util";

interface CacheEntry {
  expiresAt: number;
  value: BackupResult;
}
interface SearchBudget { deadline: number; requests: number; }
interface BackupResult { options: NormalizedMedicineOption[]; status: "ok" | "incomplete" | "unavailable" | "disabled"; failureReason?: string; statusCode?: number; }

@Injectable()
export class PharmaDbService implements MedicineProvider {
  readonly name = "pharmadb" as const;
  private readonly logger = new Logger(PharmaDbService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private unavailableUntil = 0;
  private readonly pending = new Map<string, Promise<BackupResult>>();

  constructor(
    private readonly configService: ConfigService,
    private readonly authService: PharmaDbAuthService,
    private readonly selector: CommercialMedicineSelector,
  ) {}

  async search(query: string): Promise<NormalizedMedicineOption[]> {
    return (await this.searchWithStatus(query)).options;
  }

  isEnabled() { return backupEnabled(this.configService.get("PHARMADB_ENABLED")) && this.authService.hasApiKey(); }

  async searchWithStatus(query: string): Promise<BackupResult> {
    if (!this.isEnabled()) return { options: [], status: "disabled" };
    const normalized = this.selector.normalizeMedicineName(query) || query;
    const cached = this.getFromCache(`pharmadb:${normalized}`);
    if (cached) return cached;
    if (this.pending.has(normalized)) return this.pending.get(normalized)!;
    const request = this.performSearch(normalized).finally(() => this.pending.delete(normalized));
    this.pending.set(normalized, request);
    return request;
  }

  private async performSearch(query: string): Promise<BackupResult> {

    if (this.isTemporarilyUnavailable()) {
      this.logger.warn("PharmaDB temporariamente indisponível, pulando chamada");
      return { options: [], status: "unavailable", failureReason: "provider_cooldown" };
    }

    const normalizedQuery =
      this.selector.normalizeMedicineName(query) ||
      this.selector.getCanonicalMedicineName(query);
    const cacheKey = `pharmadb:${normalizedQuery}`;
    const cached = this.getFromCache(cacheKey);

    if (cached) {
      return cached;
    }

    this.logger.log(`Chamando PharmaDB para: ${normalizedQuery}`);
    this.logger.log(`SEARCH TERM: ${normalizedQuery}`);

    try {
      const result = await this.fetchSearchResults(normalizedQuery, { deadline: Date.now() + 6000, requests: 0 });
      const rawItems = result.items;
      this.logger.log(`RESULTS FOUND: ${rawItems.length}`);
      this.logger.log(`PharmaDB retornou ${rawItems.length} resultados`);

      const normalized = rawItems.flatMap((item) => this.normalizeItem(item));
      this.logger.log(`RESULTS AFTER FILTER: ${normalized.length}`);
      this.logger.log(`PharmaDB resultados normalizados: ${normalized.length}`);
      this.logger.log(
        `PharmaDB encontrou PF para ${
          normalized.filter((item) => item.priceFactory !== undefined).length
        } itens`,
      );
      this.logger.log(
        `PHARMADB RESULT STATUS: active=${normalized.filter((item) => item.availabilityStatus === "active").length} inactive=${normalized.filter((item) => item.availabilityStatus === "inactive").length} out_of_stock=${normalized.filter((item) => item.availabilityStatus === "out_of_stock").length} no_price=${normalized.filter((item) => item.priceFactory === undefined && item.priceConsumer === undefined && item.pmcWithIcms === undefined).length}`,
      );

      const value: BackupResult = { options: normalized, status: result.incomplete ? "incomplete" : "ok" };
      this.setCache(cacheKey, value, normalized.length > 0 ? 300 : 60);
      return value;
    } catch (error) {
      this.logger.warn(
        `PHARMADB SEARCH FAILED, FALLING BACK TO BULAPI: ${
          error instanceof Error ? error.message : "erro desconhecido"
        }`,
      );
      this.markTemporarilyUnavailable(error);
      return { options: [], status: "unavailable", ...providerFailure(error) };
    }
  }

  private isTemporarilyUnavailable() {
    return Date.now() < this.unavailableUntil;
  }

  private markTemporarilyUnavailable(error: unknown) {
    const message = error instanceof Error ? error.message : "";

    this.unavailableUntil = Date.now() + (/429/.test(message) ? 300_000 : 60_000);
  }

  private async fetchSearchResults(query: string, budget: SearchBudget) {
    const perPage = 100;
    const maxPages = 2;
    const items: unknown[] = [];
    const seen = new Set<string>();
    let incomplete = false;

    for (let page = 1; page <= maxPages; page += 1) {
      const endpoint = `/produtos/busca?q=${encodeURIComponent(query)}&page=${page}&per_page=${perPage}`;
      const data = await this.fetchProtected(endpoint, budget);
      const pageItems = this.extractItems(data);
      const signature = JSON.stringify(pageItems.map((item) => this.getProductId(item)));
      if (seen.has(signature)) { incomplete = true; break; }
      seen.add(signature);
      this.logger.log(
        `PHARMADB PAGE RESULTS: endpoint=${endpoint} page=${page} count=${pageItems.length}`,
      );
      items.push(...pageItems);

      if (pageItems.length === 0 || !this.hasNextPage(data, page, pageItems.length)) break;
      if (page === maxPages) incomplete = true;
    }

    if (items.length === 0) {
      return { items: [], incomplete };
    }

    const detailedItems: unknown[] = [];

    const matching = items.filter((item) => {
      if (!item || typeof item !== "object") return false;
      const record = item as Record<string, unknown>;
      return this.selector.isSameMedicine(query, { id: 0, name: this.firstString(record, ["nome", "name"]) || "",
        substance: { name: this.firstString(record, ["principios_ativos", "principio_ativo"]) } });
    });
    incomplete ||= matching.length > 3;
    for (const item of matching.slice(0, 3)) {
      const productId = this.getProductId(item);

      if (!productId) {
        detailedItems.push(item);
        continue;
      }

      try {
        detailedItems.push(await this.fetchProtected(`/produtos/${encodeURIComponent(productId)}`, budget));
      } catch (error) {
        this.logger.warn(
          `PharmaDB falhou ao detalhar produto ${productId}: ${
            error instanceof Error ? error.message : "erro desconhecido"
          }`,
        );
        throw error;
      }
    }

    return { items: detailedItems, incomplete };
  }

  private async fetchProtected(endpoint: string, budget: SearchBudget, retried = false): Promise<unknown> {
    if (budget.requests >= 6 || Date.now() >= budget.deadline) throw new Error("PharmaDB request budget exhausted");
    budget.requests++;
    const token = await this.authService.getAccessToken(retried);

    if (!token) {
      const status = this.authService.getFailureStatus?.();
      throw new Error(status ? `PharmaDB auth HTTP ${status}` : "PharmaDB token indisponível");
    }

    const controller = new AbortController();
    if (Date.now() >= budget.deadline) throw new Error("PharmaDB deadline exceeded");
    const timeout = setTimeout(() => controller.abort(), Math.min(2500, budget.deadline - Date.now()));

    try {
      const response = await fetch(`${this.getBaseUrl()}${endpoint}`, {
        redirect: "error",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      this.logger.log(
        `PHARMADB HTTP: endpoint=${endpoint} status=${response.status}`,
      );

      if (response.status === 401 && !retried) {
        this.authService.clearToken();
        return this.fetchProtected(endpoint, budget, true);
      }

      if ([403, 429, 500, 503].includes(response.status)) {
        throw new Error(`PharmaDB respondeu ${response.status}`);
      }

      if (!response.ok) {
        throw new Error(`PharmaDB respondeu ${response.status}`);
      }

      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  private normalizeItem(raw: unknown): NormalizedMedicineOption[] {
    if (!raw || typeof raw !== "object") {
      return [];
    }

    const wrapper = raw as Record<string, unknown>;
    const item = wrapper.data && typeof wrapper.data === "object" && !Array.isArray(wrapper.data) ? wrapper.data as Record<string, unknown> : wrapper;
    const productName = this.firstString(item, [
      "nome",
      "produto",
      "nomeProduto",
      "produtoNome",
      "nome_comercial",
      "nomeComercial",
      "name",
    ]);

    if (!productName) {
      return [];
    }

    const baseOption = this.normalizeBaseProduct(item, productName);
    const presentations = this.getPresentations(item);

    if (presentations.length === 0) {
      return [baseOption];
    }

    return presentations.map((presentation, index) =>
      this.normalizePresentation(item, baseOption, presentation, index),
    );
  }

  private normalizeBaseProduct(
    item: Record<string, unknown>,
    productName: string,
  ): NormalizedMedicineOption {
    const presentation = this.firstString(item, [
      "apresentacao",
      "apresentacaoDescricao",
      "embalagem",
      "formaFarmaceutica",
      "viaAdministracao",
      "presentation",
    ]);
    const packageInfo = this.selector.extractPackageInfo(
      removeMedicineStrengths([presentation, productName].filter(Boolean).join(" ")),
    );
    const activeIngredient = this.firstString(item, [
      "principioAtivo",
      "principio_ativo",
      "principios_ativos",
      "activeIngredient",
    ]);
    const substance =
      this.firstString(item, ["substancia", "substancias", "composicao"]) ||
      this.extractCompositionText(item);

    return {
      source: "pharmadb",
      sourceId: this.firstString(item, ["id", "produtoId", "codigo", "uuid"]),
      productName,
      displayName: productName,
      activeIngredient,
      substance,
      brand: productName,
      manufacturer: this.firstString(item, [
        "fabricante",
        "detentor",
        "empresa",
      ]),
      laboratory: this.firstString(item, ["laboratorio", "lab"]),
      presentation,
      form: this.firstString(item, ["formaFarmaceutica", "forma", "form"]),
      dosage:
        this.firstString(item, ["dosagem", "concentracao", "dose"]) ||
        this.extractDosageText(item),
      packageInfo: {
        raw: presentation,
        unitCount: packageInfo.unitCount,
        volumeMl: packageInfo.volumeMl,
        isLargePack: packageInfo.isLargePackage,
        isHospitalUse: packageInfo.isHospitalUse,
        isInjectable: packageInfo.isInjectable,
      },
      regulatoryCategory: this.firstString(item, [
        "categoriaRegulatoria",
        "categoria_regulatoria",
        "regulatoryCategory",
      ]),
      anvisaRegister: this.firstString(item, [
        "registro",
        "registroAnvisa",
        "registro_anvisa",
        "numeroRegistro",
      ]),
      ean: this.firstString(item, ["ean", "codigoBarras"]),
      ggrem: this.firstString(item, ["ggrem", "codigoGGREM"]),
      priceFactory: this.firstCurrencyNumber(item, [
        "precoFabrica",
        "preco_fabrica",
        "pf",
        "PF",
        "precoPF",
        "precoFabricante",
      ], ["pf_0", "pf_12", "pf_17", "preco_fabrica_centavos"]),
      priceConsumer: this.firstCurrencyNumber(item, [
        "precoConsumidor",
        "preco_consumer",
        "pmc",
        "PMC",
      ], ["pmc_0", "pmc_12", "pmc_17", "pmc_centavos"]),
      pmcWithIcms: this.firstNumber(item, ["pmcComIcms", "pmc_com_icms"]),
      availabilityStatus: this.resolveAvailabilityStatus(item),
      bulaPacienteUrl: this.firstString(item, [
        "bulaPacienteUrl",
        "bula_paciente",
      ]),
      bulaProfissionalUrl: this.firstString(item, [
        "bulaProfissionalUrl",
        "bula_profissional",
      ]),
      raw: item,
    };
  }

  private normalizePresentation(
    product: Record<string, unknown>,
    baseOption: NormalizedMedicineOption,
    presentation: Record<string, unknown>,
    index: number,
  ): NormalizedMedicineOption {
    const description = this.firstString(presentation, [
      "descricao",
      "apresentacao",
      "apresentacao_descricao",
      "embalagem",
    ]);
    const packageInfo = this.selector.extractPackageInfo(
      removeMedicineStrengths([description, baseOption.productName].filter(Boolean).join(" ")),
    );
    const sourceId = [
      baseOption.sourceId,
      this.firstString(presentation, ["id", "apresentacao_id"]),
      this.firstString(presentation, ["ean_1", "ean", "codigo_barras"]),
      index + 1,
    ]
      .filter(Boolean)
      .join(":");
    const dosage =
      this.extractDosageFromText(description) ||
      this.firstString(presentation, ["dosagem", "concentracao", "dose"]) ||
      this.extractDosageText(product);

    return {
      ...baseOption,
      sourceId,
      displayName: baseOption.productName,
      presentation: description,
      form: description,
      dosage,
      packageInfo: {
        raw: description,
        unitCount: packageInfo.unitCount,
        volumeMl: packageInfo.volumeMl,
        isLargePack: packageInfo.isLargePackage,
        isHospitalUse: packageInfo.isHospitalUse,
        isInjectable: packageInfo.isInjectable,
      },
      ean: this.firstString(presentation, [
        "ean_1",
        "ean",
        "ean13",
        "codigo_barras",
      ]),
      priceFactory: this.firstCurrencyNumber(
        presentation,
        [
          "precoFabrica",
          "preco_fabrica",
          "pf",
          "PF",
          "precoPF",
          "precoFabricante",
        ],
        ["pf_0", "pf_12", "pf_17", "preco_fabrica_centavos"],
      ),
      priceConsumer: this.firstCurrencyNumber(
        presentation,
        ["precoConsumidor", "preco_consumer", "pmc", "PMC"],
        ["pmc_0", "pmc_12", "pmc_17", "pmc_centavos"],
      ),
      pmcWithIcms: this.firstCurrencyNumber(
        presentation,
        ["pmcComIcms", "pmc_com_icms"],
        ["pmc_0", "pmc_12", "pmc_17", "pmc_centavos"],
      ),
      availabilityStatus:
        ["inactive", "out_of_stock"].includes(baseOption.availabilityStatus || "") ? baseOption.availabilityStatus :
          this.resolveAvailabilityStatus(presentation) === "unknown" ? baseOption.availabilityStatus : this.resolveAvailabilityStatus(presentation),
      raw: { product, presentation },
    };
  }

  private extractItems(data: unknown): unknown[] {
    if (Array.isArray(data)) {
      return data;
    }

    if (!data || typeof data !== "object") {
      throw new Error("PharmaDB invalid search response");
    }

    const record = data as Record<string, unknown>;

    for (const key of ["data", "items", "results", "produtos", "content"]) {
      const value = record[key];

      if (Array.isArray(value)) {
        return value;
      }
    }

    throw new Error("PharmaDB invalid search response");
  }

  private hasNextPage(data: unknown, currentPage: number, count: number) {
    if (!data || typeof data !== "object") {
      return count >= 100;
    }

    const record = data as Record<string, unknown>;
    const meta =
      record.meta && typeof record.meta === "object"
        ? (record.meta as Record<string, unknown>)
        : record;
    const current =
      this.firstNumber(meta, ["current_page", "currentPage", "page"]) ||
      currentPage;
    const last = this.firstNumber(meta, ["last_page", "lastPage", "totalPages"]);
    const total = this.firstNumber(meta, ["total", "total_count", "totalCount"]);
    const perPage =
      this.firstNumber(meta, ["per_page", "perPage", "limit"]) || count || 100;

    if (last !== undefined) {
      return current < last;
    }

    if (total !== undefined) {
      return current * perPage < total;
    }

    return count >= 100;
  }

  private getPresentations(record: Record<string, unknown>) {
    const value = record.apresentacoes || record.presentations;

    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object",
    );
  }

  private getProductId(raw: unknown) {
    if (!raw || typeof raw !== "object") {
      return null;
    }

    return this.firstString(raw as Record<string, unknown>, [
      "id",
      "produto_id",
      "produtoId",
    ]);
  }

  private firstString(
    record: Record<string, unknown>,
    keys: string[],
  ): string | undefined {
    for (const key of keys) {
      const value = record[key];

      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }

      if (typeof value === "number") {
        return String(value);
      }

      if (Array.isArray(value)) {
        const items: string[] = value
          .map((item): string | null => {
            if (typeof item === "string") {
              return item;
            }

            if (item && typeof item === "object") {
              const objectItem = item as Record<string, unknown>;

              for (const objectKey of ["nome", "nome_dcb", "name"]) {
                const objectValue = objectItem[objectKey];

                if (typeof objectValue === "string" && objectValue.trim()) {
                  return objectValue.trim();
                }
              }
            }

            return null;
          })
          .filter((item): item is string => Boolean(item));

        if (items.length > 0) {
          return items.join(", ");
        }
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

  private firstCurrencyNumber(
    record: Record<string, unknown>,
    unitKeys: string[],
    centKeys: string[],
  ) {
    const unitValue = this.firstNumber(record, unitKeys);

    if (unitValue !== undefined) {
      return unitValue;
    }

    const centValue = this.firstNumber(record, centKeys);

    if (centValue === undefined) {
      return undefined;
    }

    return Number((centValue / 100).toFixed(2));
  }

  private extractCompositionText(record: Record<string, unknown>) {
    const composition = record.composicao;

    if (!Array.isArray(composition)) {
      return undefined;
    }

    return composition
      .map((item) => {
        if (!item || typeof item !== "object") {
          return null;
        }

        return this.firstString(item as Record<string, unknown>, [
          "nome_dcb",
          "nome",
          "principio_ativo",
        ]);
      })
      .filter(Boolean)
      .join(", ");
  }

  private extractDosageText(record: Record<string, unknown>) {
    const composition = record.composicao;

    if (!Array.isArray(composition)) {
      return undefined;
    }

    const dosages = composition
      .map((item) => {
        if (!item || typeof item !== "object") {
          return null;
        }

        return this.firstString(item as Record<string, unknown>, [
          "concentracao",
        ]);
      })
      .filter(Boolean);

    return dosages.length > 0 ? dosages.join(" + ") : undefined;
  }

  private extractDosageFromText(value?: string) {
    return value ? extractMedicineStrengths(value).map((strength) => strength.label).join("+") || undefined : undefined;
  }

  private resolveAvailabilityStatus(record: Record<string, unknown>) {
    if ([record.comercializado, record.ativo, record.active].some((value) => value === false || value === 0 || value === "false")) return "inactive" as const;
    if ([record.disponivel, record.available].some((value) => value === false) || record.estoque === 0 || record.stock === 0) return "out_of_stock" as const;
    const status = this.firstString(record, [
      "status",
      "situacao",
      "ativo",
      "active",
      "disponivel",
      "available",
      "estoque",
      "stock",
    ]);
    const normalized = status ? status.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() : "";

    if (!normalized) {
      return "unknown" as const;
    }

    if (["false", "0", "inativo", "inactive"].includes(normalized)) {
      return "inactive" as const;
    }

    if (["sem estoque", "out of stock", "indisponivel"].includes(normalized)) {
      return "out_of_stock" as const;
    }

    return "active" as const;
  }

  private getFromCache(key: string) {
    const entry = this.cache.get(key);

    if (!entry || entry.expiresAt < Date.now()) {
      this.cache.delete(key);
      return null;
    }

    return entry.value;
  }

  private setCache(key: string, value: BackupResult, ttlSeconds: number) {
    if (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  private getBaseUrl() {
    return (
      sanitizeEnv(this.configService.get("PHARMADB_API_BASE_URL")) || PHARMADB_BASE_URL
    ).replace(/\/$/, "");
  }
}
