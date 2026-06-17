import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  BulaApiService,
  CommercialMedicineOption,
  MedicineLookupSummary,
} from "./bula-api.service";
import { CommercialMedicineSelector } from "./commercial-medicine-selector";
import { NormalizedMedicineOption } from "./medicine-provider.interface";
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
  ) {}

  async searchMedicine(query: string): Promise<MedicineLookupSummary | null> {
    const normalizedQuery =
      this.selector.normalizeMedicineName(query) ||
      this.selector.getCanonicalMedicineName(query);
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
        const summary = await this.searchPharmaDb(normalizedQuery);

        if (summary && summary.options.length > 0) {
          this.setCache(`pharmadb:${normalizedQuery}`, summary, 300);
          return summary;
        }
      }

      if (providerName === "bulapi") {
        const summary = await this.bulaApiService.lookupMedicine(normalizedQuery);

        if (summary && summary.options.length > 0) {
          this.setCache(`bulapi:${normalizedQuery}`, summary, 300);
          return summary;
        }
      }
    }

    const manualSummary = await this.searchManual(normalizedQuery);
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

  private async searchPharmaDb(query: string) {
    const rawOptions = await this.pharmaDbService.search(query);

    if (rawOptions.length === 0) {
      return null;
    }

    const selected = this.selectNormalized(query, rawOptions);

    return {
      medicineName: query,
      products: [],
      options: selected,
    };
  }

  private async searchManual(query: string): Promise<MedicineLookupSummary> {
    const rawOptions = await this.popularManualService.search(query);
    const selected = this.selectNormalized(query, rawOptions);

    return {
      medicineName: query,
      products: [],
      options: selected,
    };
  }

  private selectNormalized(
    query: string,
    options: NormalizedMedicineOption[],
  ): CommercialMedicineOption[] {
    const validOptions = options.filter((option) =>
      this.selector.isSameMedicine(query, {
        id: this.toNumericId(option.sourceId, 0),
        name: option.productName,
        regulatory_category: option.regulatoryCategory,
        activeIngredient: option.activeIngredient,
        substance: { name: option.substance || option.activeIngredient },
        manufacturer: { name: option.manufacturer || option.laboratory },
      }),
    );
    const discardedCount = options.length - validOptions.length;

    if (discardedCount > 0) {
      this.logger.log(
        `Produtos descartados por nao pertencerem ao medicamento: ${discardedCount}`,
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

    return this.selector
      .selectCommercialOptions(query, mapped)
      .map((option, index) => ({ ...option, optionId: index + 1 }));
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
    const displayName = option.displayName || option.productName;
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

  private formatPackageDescription(option: NormalizedMedicineOption) {
    const info = option.packageInfo;

    if (!info) {
      return undefined;
    }

    if (info.unitCount) {
      const form = this.normalizeForm(option.form || option.presentation || "");
      const unitByForm: Record<string, string> = {
        capsula: "capsulas",
        comprimido: "comprimidos",
        dragea: "drageas",
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
