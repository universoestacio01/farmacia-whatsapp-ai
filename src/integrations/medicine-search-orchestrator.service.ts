import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ProviderRequestOutcome } from "@prisma/client";
import { SymptomMedicineRule } from "../config/symptom-medicine.config";
import { ProviderRequestLogService } from "../observability/provider-request-log.service";
import {
  BulaApiService,
  CommercialMedicineOption,
  MedicineLookupSummary,
} from "./bula-api.service";
import {
  CommercialMedicineSelector,
  ParsedMedicineQuery,
} from "./commercial-medicine-selector";
import { NormalizedMedicineOption } from "./medicine-provider.interface";
import { MedicinePriorityRulesService } from "./medicine-priority-rules.service";
import { PharmaDbService } from "./pharmadb.service";
import { PopularManualMedicineService } from "./popular-manual-medicine.service";

interface CacheEntry {
  expiresAt: number;
  value: MedicineLookupSummary;
}

@Injectable()
export class MedicineSearchOrchestratorService {
  private readonly logger = new Logger(MedicineSearchOrchestratorService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly configService: ConfigService,
    private readonly selector: CommercialMedicineSelector,
    private readonly pharmaDbService: PharmaDbService,
    private readonly bulaApiService: BulaApiService,
    private readonly popularManualService: PopularManualMedicineService,
    private readonly priorityRulesService: MedicinePriorityRulesService,
    private readonly providerRequestLog?: ProviderRequestLogService,
  ) {}

  async searchMedicine(query: string): Promise<MedicineLookupSummary | null> {
    const parsedQuery = this.selector.parseMedicineQuery(query);
    const normalizedQuery =
      parsedQuery.medicineName ||
      parsedQuery.canonicalName ||
      this.selector.getCanonicalMedicineName(query);
    const canonicalQuery =
      parsedQuery.canonicalName ||
      this.selector.getCanonicalMedicineName(normalizedQuery);
    const provider =
      this.configService.get<string>("MEDICINE_PRIMARY_PROVIDER") ||
      "pharmadb";
    const orderedProviders =
      provider === "bulapi" ? ["bulapi", "pharmadb"] : ["pharmadb", "bulapi"];

    for (const providerName of orderedProviders) {
      const cached = this.getFromCache(`${providerName}:${normalizedQuery}`);

      if (cached) {
        return cached;
      }

      if (providerName === "pharmadb") {
        const summary = await this.safeSearchPharmaDb(parsedQuery);

        if (summary && summary.options.length > 0) {
          const enhanced = await this.enhanceWithManualOptions(
            canonicalQuery,
            normalizedQuery,
            summary,
          );
          this.setCache(`pharmadb:${normalizedQuery}`, enhanced, 300);
          return enhanced;
        }
      }

      if (providerName === "bulapi") {
        const summary = await this.safeSearchBulaApi(canonicalQuery);

        if (summary && summary.options.length > 0) {
          const enhanced = await this.enhanceWithManualOptions(
            canonicalQuery,
            normalizedQuery,
            summary,
          );
          this.setCache(`bulapi:${normalizedQuery}`, enhanced, 300);
          return enhanced;
        }
      }
    }

    const manualSummary = await this.searchManual(normalizedQuery, canonicalQuery);
    this.setCache(
      `popular_manual:${normalizedQuery}`,
      manualSummary,
      manualSummary.options.length > 0 ? 300 : 60,
    );
    return manualSummary;
  }

  findSymptomOptions(message: string) {
    return this.popularManualService.findSymptomOptions(message);
  }

  findSymptomSuggestion(message: string): SymptomMedicineRule | null {
    return this.popularManualService.findSymptomSuggestion(message);
  }

  private async safeSearchPharmaDb(query: ParsedMedicineQuery) {
    const startedAt = Date.now();
    try {
      const summary = await this.searchPharmaDb(query);
      await this.providerRequestLog?.record({
        provider: "pharmadb",
        operation: "medicine_search",
        query: query.received,
        durationMs: Date.now() - startedAt,
        resultsFound: summary?.options.length ?? 0,
        resultsAfterFilter: summary?.options.length ?? 0,
        outcome: summary?.options.length
          ? ProviderRequestOutcome.SUCCESS
          : ProviderRequestOutcome.EMPTY,
      });
      return summary;
    } catch (error) {
      this.logger.warn(
        `PHARMADB SEARCH FAILED, FALLING BACK TO BULAPI: ${
          error instanceof Error ? error.message : "erro desconhecido"
        }`,
      );
      await this.providerRequestLog?.record({
        provider: "pharmadb",
        operation: "medicine_search",
        query: query.received,
        durationMs: Date.now() - startedAt,
        outcome: ProviderRequestOutcome.FAILED,
        errorMessage: error instanceof Error ? error.message : "erro desconhecido",
      });
      return null;
    }
  }

  private async safeSearchBulaApi(query: string) {
    const startedAt = Date.now();
    try {
      const summary = await this.bulaApiService.lookupMedicine(query);
      await this.providerRequestLog?.record({
        provider: "bulapi",
        operation: "medicine_search",
        query,
        durationMs: Date.now() - startedAt,
        resultsFound: summary?.options.length ?? 0,
        resultsAfterFilter: summary?.options.length ?? 0,
        outcome: summary?.options.length
          ? ProviderRequestOutcome.SUCCESS
          : ProviderRequestOutcome.EMPTY,
      });
      return summary;
    } catch (error) {
      this.logger.warn(
        `BulAPI falhou, usando catálogo manual: ${
          error instanceof Error ? error.message : "erro desconhecido"
        }`,
      );
      await this.providerRequestLog?.record({
        provider: "bulapi",
        operation: "medicine_search",
        query,
        durationMs: Date.now() - startedAt,
        outcome: ProviderRequestOutcome.FAILED,
        errorMessage: error instanceof Error ? error.message : "erro desconhecido",
      });
      return null;
    }
  }

  private async searchPharmaDb(query: ParsedMedicineQuery) {
    const queryTerms = this.getCommercialQueryTerms(query);
    this.logger.log(`PHARMADB SEARCH TERMS: ${queryTerms.join(", ")}`);
    const rawResults: NormalizedMedicineOption[] = [];

    for (const term of queryTerms) {
      rawResults.push(...(await this.pharmaDbService.search(term)));
    }

    const rawOptions = this.dedupeNormalizedOptions(rawResults);

    if (rawOptions.length === 0) {
      return null;
    }

    const selected = await this.selectNormalized(query, rawOptions);

    return {
      medicineName: query.canonicalName || query.medicineName || query.received,
      products: [],
      options: selected,
    };
  }

  private async searchManual(
    query: string,
    medicineName = query,
  ): Promise<MedicineLookupSummary> {
    const rawOptions = await this.popularManualService.search(query);
    const selected = await this.selectNormalized(
      this.selector.parseMedicineQuery(query),
      rawOptions,
    );

    return {
      medicineName,
      products: [],
      options: selected,
    };
  }

  private async enhanceWithManualOptions(
    canonicalQuery: string,
    manualQuery: string,
    summary: MedicineLookupSummary,
  ) {
    if (this.hasEnoughDistinctOptions(summary.options)) {
      return summary;
    }

    const manualOptions = await this.popularManualService.search(manualQuery);

    if (manualOptions.length === 0) {
      return summary;
    }

    const manualSelected = await this.selectNormalized(
      this.selector.parseMedicineQuery(manualQuery),
      manualOptions,
    );
    const merged = this.dedupeCommercialOptions([
      ...summary.options,
      ...manualSelected,
    ]);
    const priorityRules =
      await this.priorityRulesService.getRulesForPrinciple(canonicalQuery);
    const ranking = this.selector.rankCommercialOptions(
      manualQuery,
      merged,
      priorityRules,
    );

    this.logger.log(
      `BACKFILL CATÁLOGO MANUAL: medicamento=${canonicalQuery} antes=${summary.options.length} depois=${ranking.selected.length}`,
    );

    return {
      ...summary,
      options: ranking.selected.map((option, index) => ({
        ...option,
        optionId: index + 1,
      })),
    };
  }

  private hasEnoughDistinctOptions(options: CommercialMedicineOption[]) {
    if (options.length < 3) {
      return false;
    }

    return this.distinctOptionSignatures(options).size >= 3;
  }

  private distinctOptionSignatures(options: CommercialMedicineOption[]) {
    return new Set(
      options.map((option) =>
        this.normalize(
          [
            option.formGroup,
            option.strength,
            option.packageInfo?.unitCount,
            option.packageInfo?.volumeMl,
          ]
            .filter(Boolean)
            .join("|"),
        ).replace(/\s+/g, ""),
      ),
    );
  }

  private dedupeCommercialOptions(options: CommercialMedicineOption[]) {
    const deduped = new Map<string, CommercialMedicineOption>();

    for (const option of options) {
      const key = this.normalize(
        [
          option.productName,
          option.label,
          option.formGroup,
          option.strength,
          option.packageInfo?.unitCount,
          option.packageInfo?.volumeMl,
        ]
          .filter(Boolean)
          .join("|"),
      );

      if (!deduped.has(key)) {
        deduped.set(key, option);
      }
    }

    return [...deduped.values()];
  }

  private getCommercialQueryTerms(query: ParsedMedicineQuery) {
    const normalized =
      query.medicineName ||
      query.canonicalName ||
      this.selector.getCanonicalMedicineName(query.received);
    const canonical =
      query.canonicalName || this.selector.getCanonicalMedicineName(normalized);

    const terms = [...query.fallbackTerms, normalized, canonical];
    const expansions: Record<string, string[]> = {
      dipirona: ["novalgina", "dipirona generico", "dipirona monoidratada"],
      ibuprofeno: ["ibuprofeno generico", "alivium", "advil"],
      paracetamol: ["paracetamol generico", "tylenol"],
      nimesulida: ["neosulida"],
      neosulida: ["nimesulida"],
      tadalafila: ["tadala", "cialis"],
      sildenafila: ["viagra", "sildenafil"],
      fexofenadina: ["allegra", "cloridrato de fexofenadina"],
      ciprofloxacino: ["ciprofloxacina", "cloridrato de ciprofloxacina"],
      clonazepam: ["rivotril"],
      hidroclorotiazida: ["diurix"],
      venvanse: [
        "venvanse 30mg",
        "venvanse 50mg",
        "venvanse 70mg",
        "lisdexanfetamina",
        "lisdexamfetamina",
      ],
    };

    return this.dedupeQueryTermsForProvider([
      ...terms,
      ...(expansions[canonical] || []),
    ]);
  }

  private dedupeQueryTermsForProvider(terms: string[]) {
    const uniqueTerms = new Map<string, string>();

    for (const term of terms) {
      const cleanTerm = term.trim();

      if (!cleanTerm) {
        continue;
      }

      const providerQuery =
        this.selector.normalizeMedicineName(cleanTerm) ||
        this.selector.getCanonicalMedicineName(cleanTerm) ||
        cleanTerm;
      const key = this.normalize(providerQuery).replace(/\s+/g, "");

      if (!uniqueTerms.has(key)) {
        uniqueTerms.set(key, cleanTerm);
      }
    }

    return [...uniqueTerms.values()];
  }

  private dedupeNormalizedOptions(options: NormalizedMedicineOption[]) {
    const deduped = new Map<string, NormalizedMedicineOption>();

    for (const option of options) {
      const key = this.normalize(
        [
          option.source,
          option.sourceId,
          option.ean,
          option.productName,
          option.presentation,
          option.dosage,
        ]
          .filter(Boolean)
          .join("|"),
      );

      if (!deduped.has(key)) {
        deduped.set(key, option);
      }
    }

    return [...deduped.values()];
  }

  private async selectNormalized(
    query: ParsedMedicineQuery,
    options: NormalizedMedicineOption[],
  ): Promise<CommercialMedicineOption[]> {
    const filterTerm = query.canonicalName || query.medicineName || query.received;
    this.logger.log(`SEARCH TERM: ${query.received}`);
    this.logger.log(`TERM CONSULTADO/FILTRO: ${filterTerm}`);
    this.logger.log(`RESULTS FOUND: ${options.length}`);
    const validOptions = options.filter((option) =>
      this.selector.isSameMedicine(filterTerm, {
        id: this.toNumericId(option.sourceId, 0),
        name: option.productName,
        regulatory_category: option.regulatoryCategory,
        activeIngredient: option.activeIngredient,
        substance: { name: option.substance || option.activeIngredient },
        manufacturer: { name: option.manufacturer || option.laboratory },
      }),
    );
    this.logger.log(`RESULTS AFTER FILTER: ${validOptions.length}`);
    const discardedCount = options.length - validOptions.length;

    if (discardedCount > 0) {
      this.logger.log(
        `FILTER FAILURE REASON: itens descartados quando "${filterTerm}" nao aparece no nome, principio ativo ou substancia normalizados`,
      );
      this.logger.log(
        `Produtos descartados por não pertencerem ao medicamento: ${discardedCount}`,
      );
    }

    const mapped = validOptions.map((option, index) => {
      const numericId = this.toNumericId(option.sourceId, index + 1);
      const packageInfo = option.packageInfo?.raw
        ? this.selector.extractPackageInfo(option.packageInfo.raw)
        : this.selector.extractPackageInfo(
            [
              option.presentation,
              option.form,
              option.dosage,
              option.displayName,
            ]
              .filter(Boolean)
              .join(" "),
          );
      const formGroup = packageInfo.formGroup !== "outro"
        ? packageInfo.formGroup
        : this.normalizeForm(option.form || option.presentation || "");

      return {
        optionId: index + 1,
        productId: numericId,
        presentationId: numericId,
        productName: option.productName,
        medicineName:
          option.substance || option.activeIngredient || option.productName,
        label: this.formatLabel(option, formGroup),
        formGroup,
        strength: option.dosage,
        packageDescription: this.formatPackageDescription(option),
        packageInfo,
        pricePf: this.calculateSalePrice(option),
        selectionReason: `fonte ${option.source}`,
      } satisfies CommercialMedicineOption;
    });

    this.logger.log(`PRODUTOS ENCONTRADOS: ${mapped.length}`);
    const principleActive = query.canonicalName || filterTerm;
    const priorityRules =
      await this.priorityRulesService.getRulesForPrinciple(principleActive);
    const ranking = this.selector.rankCommercialOptions(
      query.received,
      mapped,
      priorityRules,
    );

    this.logger.log(
      `PONTUAÇÃO MEDICAMENTOS: ${JSON.stringify(ranking.scored.slice(0, 20))}`,
    );
    this.logger.log(
      `SELEÇÃO FINAL MEDICAMENTOS: ${JSON.stringify(
        ranking.selected.map((option) => ({
          label: option.label,
          categoria: option.selectionReason?.split(":")[0],
          motivo: option.selectionReason,
        })),
      )}`,
    );

    return ranking.selected.map((option, index) => ({ ...option, optionId: index + 1 }));
  }

  private calculateSalePrice(option: NormalizedMedicineOption) {
    if (option.priceFactory !== undefined) {
      return this.roundCurrency(option.priceFactory);
    }

    if (option.source !== "pharmadb") {
      return option.priceConsumer !== undefined
        ? this.roundCurrency(option.priceConsumer)
        : undefined;
    }

    const pmcPrice = option.pmcWithIcms ?? option.priceConsumer;

    if (pmcPrice === undefined) {
      return undefined;
    }

    const multiplier = this.getPharmaDbPmcMultiplier();
    const salePrice = this.roundCurrency(pmcPrice * multiplier);
    this.logger.log(`Preço base PharmaDB PMC: ${pmcPrice}`);
    this.logger.log(`Multiplicador aplicado: ${multiplier}`);
    this.logger.log(`Preço final de venda: ${salePrice}`);
    return salePrice;
  }

  private getPharmaDbPmcMultiplier() {
    const rawMultiplier =
      this.configService.get<number | string>("PHARMADB_PMC_PRICE_MULTIPLIER") ??
      0.5;
    const multiplier = Number(rawMultiplier);

    return Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 0.5;
  }

  private roundCurrency(value: number) {
    return Number(value.toFixed(2));
  }

  private formatLabel(option: NormalizedMedicineOption, formGroup: string) {
    const displayName = this.formatCommercialDisplayName(
      option.displayName || option.productName,
    );
    const normalizedDisplay = this.normalize(displayName);
    const formLabel = this.title(formGroup);
    const shouldAddForm =
      formGroup !== "outro" && !normalizedDisplay.includes(this.normalize(formGroup));
    const shouldAddDosage =
      option.dosage && !normalizedDisplay.includes(this.normalize(option.dosage));
    const parts = [
      displayName,
      shouldAddForm ? formLabel : undefined,
      shouldAddDosage ? option.dosage : undefined,
    ].filter(Boolean);

    return [...new Set(parts)].join(" ");
  }

  private formatCommercialDisplayName(value: string) {
    return value
      .toLowerCase()
      .split(/\s+/)
      .map((word) => {
        if (/^\d+(?:,\d+)?$/.test(word)) {
          return word;
        }

        if (/^(mg|ml|g)$/.test(word)) {
          return word;
        }

        return word.charAt(0).toUpperCase() + word.slice(1);
      })
      .join(" ");
  }

  private formatPackageDescription(option: NormalizedMedicineOption) {
    const info = option.packageInfo;

    if (!info) {
      return undefined;
    }

    if (info.unitCount) {
      const form = this.normalizeForm(option.form || option.presentation || "");
      const unitByForm: Record<string, string> = {
        capsula: "cápsulas",
        comprimido: "comprimidos",
        dragea: "drágeas",
        "solucao nasal": "unidade",
        spray: "unidade",
        gotas: "frasco",
        "solucao oral": "frasco",
        "suspensao oral": "frasco",
        xarope: "frasco",
      };
      const unit = unitByForm[form] || "unidades";

      if (unit === "frasco" || unit === "unidade") {
        return `${info.unitCount} ${unit}`;
      }

      return `caixa com ${info.unitCount} ${unit}`;
    }

    if (info.volumeMl) {
      return `frasco com ${info.volumeMl} ml`;
    }

    return info.raw;
  }

  private normalizeForm(value: string) {
    const normalized = value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();

    if (/\bcomprim/.test(normalized)) return "comprimido";
    if (/\bcaps/.test(normalized)) return "capsula";
    if (/\bgotas?\b/.test(normalized)) return "gotas";
    if (/\bsolucao oral\b|\boral\b/.test(normalized)) return "solucao oral";
    if (/\bsuspensao\b/.test(normalized)) return "suspensao oral";
    if (/\bxarope\b/.test(normalized)) return "xarope";
    if (/\bsolucao nasal\b|\bnasal\b/.test(normalized)) return "solucao nasal";
    if (/\bpomada\b/.test(normalized)) return "pomada";
    if (/\bcreme\b/.test(normalized)) return "creme";
    if (/\bgel\b/.test(normalized)) return "gel";
    if (/\bspray\b/.test(normalized)) return "spray";
    if (/\bdragea\b/.test(normalized)) return "dragea";
    return "outro";
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

  private getFromCache(key: string) {
    const cached = this.cache.get(key);

    if (!cached || cached.expiresAt < Date.now()) {
      this.cache.delete(key);
      return null;
    }

    return cached.value;
  }

  private setCache(key: string, value: MedicineLookupSummary, ttlSeconds: number) {
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  private title(value: string) {
    return value
      .toLowerCase()
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  private normalize(value: string) {
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }
}
