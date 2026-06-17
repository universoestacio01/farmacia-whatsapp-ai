import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CommercialMedicineSelector } from "./commercial-medicine-selector";
import {
  MedicineProvider,
  NormalizedMedicineOption,
} from "./medicine-provider.interface";
import { PharmaDbAuthService } from "./pharmadb-auth.service";

interface CacheEntry {
  expiresAt: number;
  value: NormalizedMedicineOption[];
}

@Injectable()
export class PharmaDbService implements MedicineProvider {
  readonly name = "pharmadb" as const;
  private readonly logger = new Logger(PharmaDbService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly configService: ConfigService,
    private readonly authService: PharmaDbAuthService,
    private readonly selector: CommercialMedicineSelector,
  ) {}

  async search(query: string): Promise<NormalizedMedicineOption[]> {
    if (!this.authService.hasApiKey()) {
      this.logger.warn("PHARMADB_API_KEY ausente. Pulando PharmaDB.");
      return [];
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

    try {
      const rawItems = await this.fetchSearchResults(normalizedQuery);
      this.logger.log(`PharmaDB retornou ${rawItems.length} resultados`);

      const normalized = rawItems.flatMap((item) => this.normalizeItem(item));
      this.logger.log(`PharmaDB resultados normalizados: ${normalized.length}`);
      this.logger.log(
        `PharmaDB encontrou PF para ${
          normalized.filter((item) => item.priceFactory !== undefined).length
        } itens`,
      );

      this.setCache(cacheKey, normalized, normalized.length > 0 ? 300 : 60);
      return normalized;
    } catch (error) {
      this.logger.warn(
        `PharmaDB falhou, usando fallback: ${
          error instanceof Error ? error.message : "erro desconhecido"
        }`,
      );
      return [];
    }
  }

  private async fetchSearchResults(query: string) {
    const data = await this.fetchProtected(
      `/produtos/busca?q=${encodeURIComponent(query)}&page=1&per_page=20`,
    );
    const items = this.extractItems(data);

    if (items.length === 0) {
      return [];
    }

    const detailedItems: unknown[] = [];

    for (const item of items.slice(0, 20)) {
      const productId = this.getProductId(item);

      if (!productId) {
        detailedItems.push(item);
        continue;
      }

      try {
        detailedItems.push(await this.fetchProtected(`/produtos/${productId}`));
      } catch (error) {
        this.logger.warn(
          `PharmaDB falhou ao detalhar produto ${productId}: ${
            error instanceof Error ? error.message : "erro desconhecido"
          }`,
        );
        detailedItems.push(item);
      }
    }

    return detailedItems;
  }

  private async fetchProtected(endpoint: string, retried = false): Promise<unknown> {
    const token = await this.authService.getAccessToken(retried);

    if (!token) {
      return [];
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const response = await fetch(`${this.getBaseUrl()}${endpoint}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });

      if (response.status === 401 && !retried) {
        this.authService.clearToken();
        return this.fetchProtected(endpoint, true);
      }

      if ([403, 429, 500, 503].includes(response.status)) {
        throw new Error(`PharmaDB respondeu ${response.status}`);
      }

      if (!response.ok) {
        throw new Error(`PharmaDB respondeu ${response.status}`);
      }

      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  private normalizeItem(raw: unknown): NormalizedMedicineOption[] {
    if (!raw || typeof raw !== "object") {
      return [];
    }

    const item = raw as Record<string, unknown>;
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
      [presentation, productName].filter(Boolean).join(" "),
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
      priceFactory: this.firstNumber(item, [
        "precoFabrica",
        "preco_fabrica",
        "pf",
        "PF",
        "precoPF",
        "precoFabricante",
        "pf_0",
        "pf_12",
        "pf_17",
        "preco_fabrica_centavos",
      ]),
      priceConsumer: this.firstNumber(item, [
        "precoConsumidor",
        "preco_consumer",
        "pmc",
        "PMC",
        "pmc_0",
        "pmc_12",
        "pmc_17",
        "pmc_centavos",
      ]),
      pmcWithIcms: this.firstNumber(item, ["pmcComIcms", "pmc_com_icms"]),
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
      [description, baseOption.productName].filter(Boolean).join(" "),
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
      raw: { product, presentation },
    };
  }

  private extractItems(data: unknown): unknown[] {
    if (Array.isArray(data)) {
      return data;
    }

    if (!data || typeof data !== "object") {
      return [];
    }

    const record = data as Record<string, unknown>;

    for (const key of ["data", "items", "results", "produtos", "content"]) {
      const value = record[key];

      if (Array.isArray(value)) {
        return value;
      }
    }

    return [];
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

  private getFromCache(key: string) {
    const entry = this.cache.get(key);

    if (!entry || entry.expiresAt < Date.now()) {
      this.cache.delete(key);
      return null;
    }

    return entry.value;
  }

  private setCache(key: string, value: NormalizedMedicineOption[], ttlSeconds: number) {
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  private getBaseUrl() {
    return (
      this.configService.get<string>("PHARMADB_API_BASE_URL") ||
      "https://api.pharmadb.com.br/v1"
    ).replace(/\/$/, "");
  }
}
