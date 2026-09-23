import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ProviderRequestOutcome } from "@prisma/client";
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
import { medicineStrengthMatches, medicineStrengthSignature } from "../utils/medicine-strength.util";
import { extractMedicineStrengths, removeMedicineStrengths } from "../utils/medicine-strength.util";
import { PharmaDbService } from "./pharmadb.service";
import { BulapiCatalogService } from "./bulapi-catalog.service";
import { backupPricePolicy, pharmaDbMultiplier } from "../config/medicine-backups.config";
import { formatProductDisplayName } from "../whatsapp/whatsapp-copy";
import { ProviderRequestLogService } from "../observability/provider-request-log.service";
import { catalogQuarantineReason } from "../config/catalog-quality.config";

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
    @Optional() private readonly pharmaDbService?: PharmaDbService,
    @Optional() private readonly bulapiCatalog?: BulapiCatalogService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly requestLog?: ProviderRequestLogService,
  ) {}

  async searchMedicine(query: string): Promise<MedicineLookupSummary | null> {
    const primary = await this.searchPrimaryMedicine(query);
    // Never turn a retail lookup or a safety restriction into a medicine fallback.
    if (primary.options.length || primary.retailFallbackQuery || ["restricted", "attributes_unverified"].includes(primary.searchStatus || "")) return primary;
    const parsed = this.selector.parseMedicineQuery(query);
    let missingPrice = false;
    let backupUnavailable = false;
    let backupIncomplete = false;
    for (const provider of [this.pharmaDbService, this.bulapiCatalog]) {
      if (!provider?.isEnabled()) continue;
      const key = `${provider.name}:${this.buildSearchCacheQuery(parsed, parsed.medicineName || query)}:${backupPricePolicy(provider.name, this.config)}`;
      const cached = this.getFromCache(key);
      if (cached) return cached;
      const started = Date.now();
      try {
        const result = await provider.searchWithStatus(query);
        backupUnavailable ||= result.status === "unavailable";
        backupIncomplete ||= result.status === "incomplete";
        const matched = result.options.map((option) => this.normalizeBackupOption(option)).filter((option) => {
          const reason = this.backupRejectionReason(parsed, option);
          if (reason) this.logger.log(JSON.stringify({ event: "MEDICINE_BACKUP_FILTER", provider: provider.name, query, sourceId: option.sourceId, reason }));
          return !reason;
        });
        const priced = matched.map((option) => ({ ...option, salePrice: this.backupPrice(option) }));
        missingPrice ||= priced.some((option) => !option.salePrice);
        const selected = priced.length ? await this.selectNormalized(parsed, priced) : [];
        await this.requestLog?.record({ provider: provider.name, operation: "medicine_fallback", query,
          durationMs: Date.now() - started, resultsFound: result.options.length, resultsAfterFilter: selected.length,
          outcome: result.status === "unavailable" ? ProviderRequestOutcome.FAILED : selected.length ? ProviderRequestOutcome.SUCCESS : ProviderRequestOutcome.EMPTY,
          failureReason: result.status === "unavailable" ? "backup_unavailable" : selected.length ? undefined : "no_matching_priced_presentation" });
        if (selected.length) {
          const summary: MedicineLookupSummary = { medicineName: parsed.medicineName || query, products: [], options: selected, searchStatus: result.status === "incomplete" ? "incomplete" : "found" };
          this.setCache(key, summary, 300);
          this.logger.log(JSON.stringify({ event: "MEDICINE_FALLBACK_SELECTED", provider: provider.name, query, count: selected.length }));
          return summary;
        }
      } catch {
        backupUnavailable = true;
        this.logger.warn(JSON.stringify({ event: "MEDICINE_BACKUP_FAILED", provider: provider.name, query }));
      }
    }
    return missingPrice ? { ...primary, searchStatus: "offer_unavailable" }
      : backupUnavailable ? { ...primary, searchStatus: "unavailable" }
        : backupIncomplete ? { ...primary, searchStatus: "incomplete" } : primary;
  }

  private async searchPrimaryMedicine(query: string): Promise<MedicineLookupSummary> {
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
        const result = this.precoPopularService.searchMedicinesWithStatus
          ? await this.precoPopularService.searchMedicinesWithStatus(query)
          : { options: await this.precoPopularService.searchMedicines(query), status: "ok" as const };
        if (result.status === "unavailable" || result.status === "disabled") {
          return { medicineName: normalizedQuery, products: [], options: [], searchStatus: "unavailable" };
        }
        let options = result.options;
        // Explicit brands and strengths must not turn into another presentation.
        const requestedName = this.normalize(normalizedQuery).trim();
        if (options.some((option) => this.normalize(option.brand || "") === requestedName)) {
          options = options.filter((option) => this.normalize(option.brand || "") === requestedName);
        }
        let unverified = false;
        let restricted = false;
        let medicineFound = false;
        options = options.filter((option) => {
          let reason: string | undefined;
          if (!this.selector.isSameMedicine(normalizedQuery, {
            id: 0, name: option.productName, substance: { name: option.substance || option.activeIngredient },
          })) reason = "different_medicine_or_formulation";
          if (reason) {
            this.logger.log(JSON.stringify({ event: "MEDICINE_FILTER", query, sourceId: option.sourceId, product: option.productName, reason }));
            return false;
          }
          medicineFound = true;
          if (option.packageInfo?.isInjectable || option.packageInfo?.isHospitalUse) {
            reason = "restricted_retail_presentation";
            restricted = true;
          } else if (parsedQuery.dosage && !medicineStrengthMatches(option.dosage || "", parsedQuery.dosage)) {
            reason = option.dosage ? "different_strength" : "missing_strength";
            unverified ||= !option.dosage;
          } else if (parsedQuery.formGroup && option.form !== parsedQuery.formGroup) {
            reason = !option.form || option.form === "outro" ? "missing_form" : "different_form";
            unverified ||= reason === "missing_form";
          } else if (parsedQuery.packageQuantity !== undefined && option.packageInfo?.unitCount !== parsedQuery.packageQuantity) {
            reason = "different_or_missing_package_quantity";
            unverified ||= option.packageInfo?.unitCount === undefined;
          }
          if (reason) this.logger.log(JSON.stringify({ event: "MEDICINE_FILTER", query, sourceId: option.sourceId, product: option.productName, reason }));
          return !reason;
        });
        const selected = options.length ? await this.selectNormalized(parsedQuery, options) : [];
        if (selected.length) {
          const summary: MedicineLookupSummary = { medicineName: normalizedQuery, products: [], options: selected, searchStatus: result.status === "incomplete" ? "incomplete" : "found" };
          if (result.status === "ok") this.setCache(`preco_popular:${cacheQuery}`, summary, 300);
          return summary;
        }
        const failureReason = "failureReason" in result ? result.failureReason : undefined;
        return {
          medicineName: normalizedQuery, products: [], options: [], failureReason,
          retailFallbackQuery: !result.options.length && "retailFallbackQuery" in result ? result.retailFallbackQuery : undefined,
          searchStatus: result.status === "incomplete" ? "incomplete"
            : unverified || failureReason === "quarantined" ? "attributes_unverified"
              : restricted ? "restricted"
                : failureReason === "no_price" || failureReason === "out_of_stock" ? "offer_unavailable"
                  : medicineFound ? "presentation_not_found" : "not_found",
        };
      } catch (error) {
        this.logger.warn(`PRECO POPULAR MEDICINE SEARCH FAILED: ${error instanceof Error ? error.message : "erro desconhecido"}`);
        return { medicineName: normalizedQuery, products: [], options: [], searchStatus: "unavailable" };
      }
    }
    return { medicineName: canonicalQuery, products: [], options: [], searchStatus: "unavailable" };
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
    const filterTerm = query.medicineName || query.canonicalName || query.received;
    this.logger.log(`SEARCH TERM: ${query.received}`);
    this.logger.log(`TERM CONSULTADO/FILTRO: ${filterTerm}`);
    this.logger.log(`RESULTS FOUND: ${options.length}`);
    const validOptions = options.filter((option) =>
      ["preco_popular", "pharmadb", "bulapi"].includes(option.source) && Number.isFinite(option.salePrice) && (option.salePrice ?? 0) > 0 &&
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
      const parsedPackageInfo = option.packageInfo?.raw
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
      const packageInfo = {
        ...parsedPackageInfo,
        unitCount: option.packageInfo?.unitCount ?? parsedPackageInfo.unitCount,
        volumeMl: option.packageInfo?.volumeMl ?? parsedPackageInfo.volumeMl,
        isInjectable: Boolean(option.packageInfo?.isInjectable || parsedPackageInfo.isInjectable),
        isHospitalUse: Boolean(option.packageInfo?.isHospitalUse || parsedPackageInfo.isHospitalUse),
      };
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
        pricePolicy: option.source === "preco_popular" ? CATALOG_PRICE_POLICY : backupPricePolicy(option.source, this.config),
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

  private normalizeBackupOption(option: NormalizedMedicineOption): NormalizedMedicineOption {
    const description = (option.presentation || option.packageInfo?.raw || "").replace(/\bunid\.?\b/gi, "unidades");
    const info = this.selector.extractPackageInfo([description, option.productName].join(" "));
    const strengths = extractMedicineStrengths(option.dosage || description);
    const packaging = removeMedicineStrengths(description);
    const packInfo = this.selector.extractPackageInfo(packaging);
    const units = packaging.match(/\b(\d+)\s*(?:comprimidos?|capsulas?|unidades?|cp|comp|caps)\b/i);
    const volume = packaging.match(/\b(\d+(?:[,.]\d+)?)\s*ml\b/i);
    const form = info.formGroup !== "outro" ? info.formGroup : this.normalizeForm(option.form || "");
    const volumeMl = option.packageInfo?.volumeMl ?? (volume ? Number(volume[1].replace(",", ".")) : info.volumeMl);
    const unverifiedLiquid = Boolean(volumeMl && !["capsula", "comprimido", "dragea"].includes(form) && strengths.some((strength) => !strength.denominator));
    const dosage = unverifiedLiquid ? undefined : strengths.map((strength) => strength.label).join("+") || undefined;
    return { ...option, dosage, form,
      displayName: formatProductDisplayName([removeMedicineStrengths(option.productName), form === "outro" ? undefined : form, dosage].filter(Boolean).join(" ")),
      packageInfo: { ...option.packageInfo, raw: description, unitCount: option.packageInfo?.unitCount ?? (units ? Number(units[1]) : packInfo.unitCount), volumeMl,
        isInjectable: Boolean(option.packageInfo?.isInjectable || info.isInjectable), isHospitalUse: Boolean(option.packageInfo?.isHospitalUse || info.isHospitalUse) } };
  }

  private backupRejectionReason(query: ParsedMedicineQuery, option: NormalizedMedicineOption) {
    if (catalogQuarantineReason({ ean: option.ean })) return "quarantined";
    if (!this.selector.isSameMedicine(query.medicineName || query.received, { id: 0, name: option.productName, substance: { name: option.substance || option.activeIngredient } })) return "different_medicine_or_formulation";
    if (["inactive", "out_of_stock"].includes(option.availabilityStatus || "")) return "inactive_or_unavailable";
    if (option.packageInfo?.isInjectable || option.packageInfo?.isHospitalUse) return "restricted_retail_presentation";
    if (query.dosage && !medicineStrengthMatches(option.dosage || "", query.dosage)) return "different_or_missing_strength";
    if (query.formGroup && option.form !== query.formGroup) return "different_or_missing_form";
    if (query.packageQuantity !== undefined && option.packageInfo?.unitCount !== query.packageQuantity) return "different_or_missing_package_quantity";
    if (!option.dosage || !option.form || option.form === "outro") return "unverified_presentation";
    return undefined;
  }

  private backupPrice(option: NormalizedMedicineOption) {
    const pf = option.priceFactory;
    const pmc = option.pmcWithIcms ?? option.priceConsumer;
    const price = typeof pf === "number" && pf > 0 ? pf
      : option.source === "pharmadb" && typeof pmc === "number" ? pmc * pharmaDbMultiplier(this.config) : undefined;
    return typeof price === "number" && Number.isFinite(price) && price > 0 ? Math.round((price + Number.EPSILON) * 100) / 100 : undefined;
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
    if (/\bsuspensao\b/.test(normalized)) return "suspensao oral";
    if (/\bsolucao oral\b|\boral\b/.test(normalized)) return "solucao oral";
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
      query.dosage ? medicineStrengthSignature(query.dosage) : "qualquer_dosagem",
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
