import { Injectable, Logger } from "@nestjs/common";
import { SymptomMedicineRule } from "../config/symptom-medicine.config";
import {
  CommercialMedicineOption,
  MedicineLookupSummary,
} from "./bula-api.service";
import {
  CommercialMedicineSelector,
  ParsedMedicineQuery,
} from "./commercial-medicine-selector";
import { NormalizedMedicineOption } from "./medicine-provider.interface";
import { MedicinePriorityRulesService } from "./medicine-priority-rules.service";
import { PopularManualMedicineService } from "./popular-manual-medicine.service";
import { PrecoPopularService } from "./preco-popular.service";
import { CATALOG_PRICE_POLICY } from "../config/preco-popular.config";

interface CacheEntry {
  expiresAt: number;
  value: MedicineLookupSummary;
}

@Injectable()
export class MedicineSearchOrchestratorService {
  private readonly logger = new Logger(MedicineSearchOrchestratorService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly selector: CommercialMedicineSelector,
    private readonly popularManualService: PopularManualMedicineService,
    private readonly priorityRulesService: MedicinePriorityRulesService,
    private readonly precoPopularService: PrecoPopularService,
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
    const cacheQuery = this.buildSearchCacheQuery(parsedQuery, normalizedQuery);
    if (this.precoPopularService?.isEnabled()) {
      const cached = this.getFromCache(`preco_popular:${cacheQuery}`);
      if (cached) return cached;
      try {
        let options = await this.precoPopularService.searchMedicines(query);
        // Explicit brands and strengths must not turn into another presentation.
        const requestedName = this.normalize(normalizedQuery).trim();
        if (options.some((option) => this.normalize(option.brand || "") === requestedName)) {
          options = options.filter((option) => this.normalize(option.brand || "") === requestedName);
        }
        options = options.filter((option) => {
          if (parsedQuery.dosageMg !== undefined) {
            const strength = this.selector.parseMedicineQuery(option.dosage || "");
            if (strength.dosageMg !== parsedQuery.dosageMg) return false;
            if (Boolean(option.dosage?.includes("/")) !== Boolean(parsedQuery.dosage?.includes("/"))) return false;
          }
          if (parsedQuery.formGroup && option.form !== parsedQuery.formGroup) return false;
          if (parsedQuery.packageQuantity !== undefined && option.packageInfo?.unitCount !== parsedQuery.packageQuantity) return false;
          return true;
        });
        const selected = await this.selectNormalized(parsedQuery, options);
        if (selected.length) {
          const summary = { medicineName: canonicalQuery, products: [], options: selected };
          this.setCache(`preco_popular:${cacheQuery}`, summary, 300);
          return summary;
        }
      } catch (error) {
        this.logger.warn(`PRECO POPULAR MEDICINE SEARCH FAILED: ${error instanceof Error ? error.message : "erro desconhecido"}`);
      }
    }
    return { medicineName: canonicalQuery, products: [], options: [] };
  }

  findSymptomOptions(message: string) {
    return this.popularManualService.findSymptomOptions(message);
  }

  findSymptomSuggestion(message: string): SymptomMedicineRule | null {
    return this.popularManualService.findSymptomSuggestion(message);
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
      option.source === "preco_popular" && Number.isFinite(option.salePrice) && (option.salePrice ?? 0) > 0 &&
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
        label: option.displayName,
        formGroup,
        strength: option.dosage,
        packageDescription: this.formatPackageDescription(option),
        packageInfo,
        pricePf: option.salePrice,
        pricePolicy: CATALOG_PRICE_POLICY,
        brand: option.brand,
        imageUrl: option.imageUrl,
        ean: option.ean,
        sourceId: option.sourceId,
        selectionReason: `fonte ${option.source}`,
        source: option.source,
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
    if (/\bsolucao nasal\b|\bsol nas\b|\bnasal\b/.test(normalized)) {
      return "solucao nasal";
    }
    if (/\bgotas?\b/.test(normalized)) return "gotas";
    if (/\bsolucao oral\b|\boral\b/.test(normalized)) return "solucao oral";
    if (/\bsuspensao\b/.test(normalized)) return "suspensao oral";
    if (/\bxarope\b/.test(normalized)) return "xarope";
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

  private buildSearchCacheQuery(
    query: ParsedMedicineQuery,
    normalizedQuery: string,
  ) {
    return [
      normalizedQuery,
      query.dosageMg !== undefined ? `${query.dosageMg}mg` : "qualquer_dosagem",
      query.formGroup || "qualquer_forma",
      query.packageQuantity !== undefined
        ? `${query.packageQuantity}un`
        : "qualquer_embalagem",
    ].join(":");
  }

  private setCache(key: string, value: MedicineLookupSummary, ttlSeconds: number) {
    if (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  private normalize(value: string) {
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }
}
