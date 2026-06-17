import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  CommercialMedicineSelector,
  PackageInfo,
  SelectorPresentation,
  SelectorProduct,
} from "./commercial-medicine-selector";

export type MedicineIntent =
  | "leaflet"
  | "contraindication"
  | "composition"
  | "dosage"
  | "price"
  | "presentation"
  | "purchase";

export interface MedicineQuestion {
  intent: MedicineIntent;
  medicineName: string;
}

export interface CommercialMedicineOption {
  optionId: number;
  productId: number;
  presentationId: number;
  productName: string;
  medicineName: string;
  label: string;
  formGroup: string;
  strength?: string;
  packageDescription?: string;
  packageInfo?: PackageInfo;
  pricePf?: number;
  selectionReason?: string;
}

export interface MedicineLookupSummary {
  medicineName: string;
  products: BulaApiProduct[];
  options: CommercialMedicineOption[];
}

interface BulaApiListResponse<T> {
  data?: T;
}

interface BulaApiSearchResponse {
  data?: {
    substances?: BulaApiSubstance[];
    products?: BulaApiProduct[];
  };
}

interface BulaApiSubstance {
  id: number;
  name: string;
}

interface BulaApiProduct extends SelectorProduct {
  id: number;
  name: string;
  regulatory_category?: string;
  activeIngredient?: string | { name?: string } | null;
  substance?: {
    id: number;
    name: string;
  };
  manufacturer?: {
    id: number;
    name: string;
  };
}

interface BulaApiPresentation extends SelectorPresentation {
  id: number;
  dose_form?: string;
  route?: string;
  strength?: string;
  package_quantity?: number;
  package_description?: string | null;
  product?: {
    id: number;
    name: string;
  };
}

interface BulaApiPrice {
  pf_prices?: Record<string, number | string | null | undefined>;
}

interface CommercialProductSelection {
  product: BulaApiProduct;
  reason: string;
  score: number;
}

@Injectable()
export class BulaApiService {
  private readonly logger = new Logger(BulaApiService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly selector: CommercialMedicineSelector,
  ) {}

  isPriceQuestionWithoutMedicine(message: string) {
    const normalized = this.normalize(message).trim();
    const hasPriceIntent =
      /^(qual\s+)?(preco|valor)(\?)?$/.test(normalized) ||
      /^quanto\s+custa(\?)?$/.test(normalized);

    return hasPriceIntent && !this.normalizeMedicineName(message);
  }

  detectMedicineQuestion(message: string): MedicineQuestion | null {
    const normalized = this.normalize(message);
    const compact = normalized.replace(/[?!.:,;]/g, " ");
    const intentPatterns: Array<{
      intent: MedicineIntent;
      patterns: RegExp[];
    }> = [
      {
        intent: "contraindication",
        patterns: [
          /\bcontraindic(?:acao|acoes|ado|ada|a)\s+(?:da|do|de)?\s*(.+)$/i,
          /\b(?:nao pode|quem nao pode)\s+(?:tomar|usar)\s+(.+)$/i,
        ],
      },
      {
        intent: "composition",
        patterns: [
          /\bcomposicao\s+(?:da|do|de)?\s*(.+)$/i,
          /\bdo que e feito\s+(.+)$/i,
        ],
      },
      {
        intent: "dosage",
        patterns: [
          /\bposologia\s+(?:da|do|de)?\s*(.+)$/i,
          /\bcomo\s+(?:tomar|usar)\s+(.+)$/i,
        ],
      },
      {
        intent: "price",
        patterns: [
          /\bqual\s+(?:o\s+)?(?:preco|valor)\s+(?:da|do|de)?\s*(.+)$/i,
          /\bpreco\s+(?:da|do|de)?\s*(.+)$/i,
          /\bvalor\s+(?:da|do|de)?\s*(.+)$/i,
          /\bquanto custa\s+(.+)$/i,
        ],
      },
      {
        intent: "presentation",
        patterns: [
          /\bapresentacao\s+(?:da|do|de)?\s*(.+)$/i,
          /\b(?:tem|existe)\s+(.+)\s+(?:em|de)\s+(?:comprimido|capsula|gotas|xarope|solucao)$/i,
        ],
      },
      {
        intent: "leaflet",
        patterns: [
          /\bbula\s+(?:da|do|de)?\s*(.+)$/i,
          /\bpara que serve\s+(.+)$/i,
        ],
      },
      {
        intent: "purchase",
        patterns: [
          /\bquero\s+(.+)$/i,
          /\bqueria\s+(?:de|da|do)?\s*(.+)$/i,
          /\bpreciso\s+(?:de|da|do)?\s*(.+)$/i,
          /\bvoces tem\s+(.+)$/i,
          /\bvende(?:m)?\s+(.+)$/i,
          /\bteria\s+(.+)$/i,
          /\btem\s+(.+)$/i,
          /^(.+)\s+tem$/i,
        ],
      },
    ];

    for (const { intent, patterns } of intentPatterns) {
      for (const pattern of patterns) {
        const match = compact.match(pattern);
        const medicineName =
          this.normalizeMedicineName(match?.[1] || "") ||
          this.cleanMedicineName(match?.[1]);

        if (medicineName) {
          return { intent, medicineName };
        }
      }
    }

    const commercialIntent = this.detectCommercialIntent(message);
    const medicineFromIntent = this.normalizeMedicineName(message);

    if (commercialIntent && medicineFromIntent) {
      return { intent: commercialIntent, medicineName: medicineFromIntent };
    }

    const bareMedicine = this.detectBareMedicineName(compact);
    return bareMedicine
      ? { intent: "purchase", medicineName: bareMedicine }
      : null;
  }

  extractMedicineName(message: string) {
    return this.normalizeMedicineName(message);
  }

  normalizeMedicineName(message: string) {
    return this.selector.normalizeMedicineName(message);
  }

  isSameMedicine(query: string, product: BulaApiProduct) {
    return this.selector.isSameMedicine(query, product);
  }

  optionBelongsToMedicine(
    query: string | null | undefined,
    option: CommercialMedicineOption,
  ) {
    if (!query) {
      return true;
    }

    return this.selector.isSameMedicine(query, {
      id: option.productId,
      name: option.productName,
      substance: { name: option.medicineName },
    });
  }

  async lookupMedicine(
    medicineName: string,
  ): Promise<MedicineLookupSummary | null> {
    const baseUrl = this.getBaseUrl();
    this.logger.log(`Chamando BulAPI para: ${medicineName}`);

    try {
      const products = await this.searchCommercialProducts(
        baseUrl,
        medicineName,
      );
      this.logger.log(`Produtos brutos BulAPI: ${products.rawCount}`);
      this.logger.log(
        `Produtos do mesmo medicamento: ${products.sameMedicineCount}`,
      );
      this.logger.log(
        `Produtos descartados por nao pertencerem ao medicamento: ${products.discardedNames.join(", ") || "nenhum"}`,
      );
      this.logger.log(
        `Produtos retornados pela busca: ${products.items.map((product) => product.name).join(", ") || "nenhum"}`,
      );

      const selection = this.selectCommercialProduct(
        medicineName,
        products.items,
      );

      if (selection) {
        this.logger.log(
          `Produto comercial selecionado: ${selection.product.name}. Motivo da selecao: ${selection.reason}`,
        );
      }

      const options = await this.getCommercialOptions(
        baseUrl,
        medicineName,
        products.items,
      );
      this.logger.log(`Opcoes filtradas: ${options.length}`);
      this.logger.log(
        `Opcoes comerciais selecionadas: ${options.map((option) => option.label).join(", ") || "nenhuma"}`,
      );

      return {
        medicineName,
        products: products.items,
        options,
      };
    } catch (error) {
      this.logger.error(
        `Falha ao consultar BulAPI para "${medicineName}"`,
        error,
      );
      return null;
    }
  }

  async buildMedicineReply(question: MedicineQuestion): Promise<string | null> {
    const summary = await this.lookupMedicine(question.medicineName);

    if (!summary) {
      return null;
    }

    if (summary.products.length === 0) {
      return this.formatNotFound(question.medicineName);
    }

    if (question.intent === "price") {
      return this.formatPriceReply(summary);
    }

    return this.formatPresentationChoiceReply(summary);
  }

  selectCommercialProduct(
    medicineName: string,
    products: BulaApiProduct[],
  ): CommercialProductSelection | null {
    const ranked = this.rankProducts(products, medicineName);
    const product = ranked[0];

    if (!product) {
      return null;
    }

    return {
      product,
      reason: this.getProductSelectionReason(product, medicineName),
      score: this.getProductScore(product, medicineName),
    };
  }

  async getHighestPfForSelectedProduct(
    baseUrl: string,
    product: BulaApiProduct,
    presentation: BulaApiPresentation,
  ) {
    const response = await this.fetchJson<BulaApiListResponse<BulaApiPrice[]>>(
      `${baseUrl}/presentations/${presentation.id}/prices`,
    );
    const prices: number[] = [];

    for (const price of response.data || []) {
      for (const value of Object.values(price.pf_prices || {})) {
        const numericValue =
          typeof value === "number"
            ? value
            : Number(String(value).replace(",", "."));

        if (Number.isFinite(numericValue)) {
          prices.push(numericValue);
        }
      }
    }

    this.logger.log(
      `PFs disponiveis para o produto selecionado ${product.name} ${this.formatOptionLabel(presentation)}: ${prices.join(", ") || "nenhum"}`,
    );
    const highestPf = prices.length > 0 ? Math.max(...prices) : undefined;
    this.logger.log(
      `Maior PF escolhido dentro do produto selecionado: ${highestPf ?? "nenhum"}`,
    );

    return highestPf;
  }

  async priceSelectedOption(option: CommercialMedicineOption) {
    const baseUrl = this.getBaseUrl();
    const pricePf = await this.getHighestPfForSelectedProduct(
      baseUrl,
      {
        id: option.productId,
        name: option.productName,
        substance: { id: 0, name: option.medicineName },
      },
      {
        id: option.presentationId,
        dose_form: option.formGroup,
        strength: option.strength,
        package_description: option.packageDescription,
      },
    );
    this.logger.log(
      `Preco calculado dentro do produto selecionado: ${option.label} = ${pricePf ?? "nenhum"}`,
    );

    return { ...option, pricePf };
  }

  formatNotFound(medicineName: string) {
    return `Nao encontrei "${medicineName}" na base de medicamentos. Pode confirmar o nome do remedio ou enviar uma foto da embalagem?`;
  }

  formatPresentationChoiceReply(summary: MedicineLookupSummary) {
    if (summary.options.length === 0) {
      return `Encontrei ${this.title(summary.products[0]?.name || summary.medicineName)}, mas nao achei apresentacoes comuns de varejo. Pode me dizer se voce quer comprimido, gotas, capsula ou xarope?`;
    }

    if (summary.options.length === 1) {
      return this.formatSelectedOptionReply(summary.options[0]);
    }

    const lines = [
      `Encontrei ${this.title(summary.medicineName)}. Qual apresentacao voce deseja?`,
      "",
    ];

    for (const option of summary.options.slice(0, 3)) {
      lines.push(`${option.optionId}. ${this.formatOptionLine(option)}`);
    }

    const optionNumbers = summary.options
      .slice(0, 3)
      .map((option) => option.optionId)
      .join(", ");
    lines.push("", `Responda ${optionNumbers}.`);
    return lines.join("\n");
  }

  formatPriceReply(summary: MedicineLookupSummary) {
    if (summary.options.length === 0) {
      return `Encontrei ${this.title(summary.products[0]?.name || summary.medicineName)}, mas nao achei preco regulado para apresentacao comum de varejo. Pode me dizer se voce quer comprimido, gotas, capsula ou xarope?`;
    }

    if (summary.options.length === 1) {
      return this.formatSelectedOptionReply(summary.options[0]);
    }

    const lines = [
      `Encontrei algumas opcoes de ${this.title(summary.medicineName)}:`,
      "",
    ];

    for (const option of summary.options.slice(0, 3)) {
      lines.push(`${option.optionId}. ${this.formatOptionLine(option)}`);
    }

    lines.push("", "Qual voce prefere?");
    return lines.join("\n");
  }

  formatSelectedOptionReply(option: CommercialMedicineOption) {
    const lines = [`Perfeito, separei ${option.label}.`];

    if (option.packageDescription) {
      lines.push(`Embalagem: ${option.packageDescription}.`);
    }

    lines.push(
      option.pricePf
        ? `Valor: ${this.formatCurrency(option.pricePf)}.`
        : "Nao encontrei preco regulado para essa apresentacao.",
      "",
      "Quantas unidades voce deseja?",
    );

    return lines.join("\n");
  }

  findOptionByReply(
    message: string,
    options: CommercialMedicineOption[],
  ): CommercialMedicineOption | null {
    const normalized = this.normalize(message).trim();
    const numericChoice = Number(normalized);

    if (Number.isInteger(numericChoice)) {
      return (
        options.find((option) => option.optionId === numericChoice) || null
      );
    }

    let candidates = options;
    const requestedBrand = this.detectBrandPreference(message);
    const requestedGeneric = this.detectGenericPreference(message);
    const requestedGroup = this.detectPresentationKeyword(message);

    if (requestedBrand) {
      candidates = candidates.filter((option) =>
        this.normalize(option.productName).includes(requestedBrand),
      );
    }

    if (requestedGeneric) {
      candidates = candidates.filter((option) =>
        this.selector.isGenericProduct(
          {
            id: option.productId,
            name: option.productName,
            substance: { name: option.medicineName },
          },
          option.medicineName,
        ),
      );
    }

    if (requestedGroup) {
      candidates = candidates.filter(
        (option) => option.formGroup === requestedGroup,
      );
    }

    return candidates[0] || null;
  }

  detectPresentationKeyword(message: string) {
    const normalized = this.normalize(message);

    if (/\bcomprim/.test(normalized)) return "comprimido";
    if (/\bcaps/.test(normalized)) return "capsula";
    if (/\bgotas?\b/.test(normalized)) return "gotas";
    if (/\bxarope\b/.test(normalized)) return "xarope";
    if (/\bsuspensao\b/.test(normalized)) return "suspensao oral";
    if (/\bsolucao\s+oral\b|\boral\b/.test(normalized)) return "solucao oral";
    if (/\bpomada\b/.test(normalized)) return "pomada";
    if (/\bcreme\b/.test(normalized)) return "creme";
    if (/\bgel\b/.test(normalized)) return "gel";
    if (/\bspray\b/.test(normalized)) return "spray";

    return null;
  }

  private async searchCommercialProducts(
    baseUrl: string,
    medicineName: string,
  ) {
    const productMap = new Map<number, BulaApiProduct>();

    for (const term of this.getCommercialQueryTerms(medicineName)) {
      const search = await this.fetchJson<BulaApiSearchResponse>(
        `${baseUrl}/search?q=${encodeURIComponent(term)}`,
      );

      for (const product of search.data?.products || []) {
        productMap.set(product.id, product);
      }

      const substance = search.data?.substances?.find((item) =>
        this.selector
          .getCanonicalMedicineName(item.name)
          .includes(this.selector.getCanonicalMedicineName(medicineName)),
      );

      if (substance) {
        const substanceProducts = await this.fetchJson<
          BulaApiListResponse<BulaApiProduct[]>
        >(`${baseUrl}/substances/${substance.id}/products?per_page=20`);

        for (const product of substanceProducts.data || []) {
          productMap.set(product.id, product);
        }
      }
    }

    const rawProducts = [...productMap.values()];
    const { sameMedicine, discarded } = this.selector.filterSameMedicine(
      medicineName,
      rawProducts,
    );

    return {
      rawCount: rawProducts.length,
      sameMedicineCount: sameMedicine.length,
      discardedNames: discarded.map((product) => product.name),
      items: this.rankProducts(sameMedicine, medicineName).slice(0, 16),
    };
  }

  private async getCommercialOptions(
    baseUrl: string,
    medicineName: string,
    products: BulaApiProduct[],
  ) {
    const options: CommercialMedicineOption[] = [];
    const discardedPresentations: string[] = [];

    for (const product of products) {
      const productSelection = this.selectCommercialProduct(medicineName, [
        product,
      ]);
      const response = await this.fetchJson<
        BulaApiListResponse<BulaApiPresentation[]>
      >(`${baseUrl}/products/${product.id}/presentations?per_page=30`);

      for (const presentation of response.data || []) {
        if (!this.selector.isRetailPresentation(presentation)) {
          discardedPresentations.push(
            `${product.name} ${this.presentationText(presentation)}`.trim(),
          );
          continue;
        }

        const packageInfo = this.selector.extractPackageInfo(
          this.presentationText(presentation),
        );
        options.push({
          optionId: 0,
          productId: product.id,
          presentationId: presentation.id,
          productName: product.name,
          medicineName: product.substance?.name || product.name,
          label: this.formatCommercialOptionLabel(
            product,
            presentation,
            medicineName,
          ),
          formGroup: this.selector.getPresentationGroup(presentation),
          strength: presentation.strength,
          packageDescription: this.formatPackageDescription(
            presentation,
            packageInfo,
          ),
          packageInfo,
          selectionReason: productSelection?.reason,
        });
      }
    }

    this.logger.log(
      `Produtos descartados por embalagem grande/hospitalar: ${discardedPresentations.join(", ") || "nenhum"}`,
    );

    return this.rankOptions(options, medicineName).map((option, index) => ({
      ...option,
      optionId: index + 1,
    }));
  }

  private isRetailPresentation(presentation: BulaApiPresentation) {
    return this.selector.isRetailPresentation(presentation);
  }

  private rankOptions(
    options: CommercialMedicineOption[],
    medicineName: string,
  ) {
    return this.selector.selectCommercialOptions(medicineName, options);
  }

  private diversifyDipironaOptions(options: CommercialMedicineOption[]) {
    const picked: CommercialMedicineOption[] = [];
    const pick = (predicate: (option: CommercialMedicineOption) => boolean) => {
      const option = options.find(
        (candidate) =>
          predicate(candidate) &&
          !picked.some(
            (item) => item.presentationId === candidate.presentationId,
          ),
      );

      if (option) {
        picked.push(option);
      }
    };

    pick(
      (option) =>
        this.normalize(option.productName).includes("novalgina") &&
        option.formGroup === "comprimido" &&
        this.normalize(option.strength || "").includes("500"),
    );
    pick(
      (option) =>
        this.isGenericProductName(option.productName) &&
        option.formGroup === "comprimido" &&
        this.normalize(option.strength || "").includes("500"),
    );
    pick(
      (option) =>
        this.isGenericProductName(option.productName) &&
        ["gotas", "solucao oral"].includes(option.formGroup),
    );
    pick((option) => ["gotas", "solucao oral"].includes(option.formGroup));
    pick(
      (option) =>
        this.normalize(option.productName).includes("novalgina") &&
        option.formGroup === "comprimido" &&
        this.normalize(option.strength || "").includes("1"),
    );

    for (const option of options) {
      if (
        !picked.some((item) => item.presentationId === option.presentationId)
      ) {
        picked.push(option);
      }
    }

    return picked;
  }

  private optionScore(option: CommercialMedicineOption) {
    const priority: Record<string, number> = {
      comprimido: 100,
      capsula: 95,
      gotas: 90,
      "solucao oral": 88,
      "suspensao oral": 86,
      xarope: 84,
      pomada: 82,
      creme: 80,
      gel: 78,
      spray: 76,
    };

    return (
      (priority[option.formGroup] || 0) +
      this.productNameScore(option.productName) +
      this.strengthScore(option.strength)
    );
  }

  private formatOptionLabel(presentation: BulaApiPresentation) {
    const group = this.selector.getPresentationGroup(presentation);
    const details = [this.title(group), presentation.strength]
      .filter((item) => item && item !== "unknown")
      .join(" ");

    return details || this.title(group);
  }

  private formatCommercialOptionLabel(
    product: BulaApiProduct,
    presentation: BulaApiPresentation,
    medicineName: string,
  ) {
    const productName = this.formatProductDisplayName(product, medicineName);
    const group = this.selector.getPresentationGroup(presentation);
    const strength = this.formatStrength(presentation.strength);
    let presentationName = this.title(group);

    if (group === "gotas" || group === "solucao oral") {
      presentationName = "Gotas / solucao oral";
    } else if (strength) {
      presentationName = `${presentationName} ${strength}`;
    }

    return `${productName} ${presentationName}`.replace(/\s+/g, " ").trim();
  }

  private formatProductDisplayName(
    product: BulaApiProduct,
    medicineName: string,
  ) {
    const productName = this.normalize(product.name);
    const canonical = this.selector.getCanonicalMedicineName(medicineName);

    if (productName.includes("novalgina")) {
      return "Novalgina";
    }

    if (productName.includes("alivium")) {
      return "Alivium";
    }

    if (productName.includes("advil")) {
      return "Advil";
    }

    if (productName.includes("tylenol")) {
      return "Tylenol";
    }

    if (this.selector.isGenericProduct(product, medicineName)) {
      return `${this.title(canonical)} generico`;
    }

    return this.title(product.name);
  }

  private formatStrength(strength?: string) {
    if (!strength) {
      return "";
    }

    return strength
      .toUpperCase()
      .replace(/\s*MG\b/g, "mg")
      .replace(/\s*G\b/g, "g")
      .replace(/\s+/g, " ")
      .trim();
  }

  private formatOptionLine(option: CommercialMedicineOption) {
    return option.packageDescription
      ? `${option.label} - ${option.packageDescription}`
      : option.label;
  }

  private formatPackageDescription(
    presentation: BulaApiPresentation,
    packageInfo?: PackageInfo,
  ): string | undefined {
    const group =
      packageInfo?.formGroup || this.selector.getPresentationGroup(presentation);

    if (packageInfo?.unitCount && group !== "outro") {
      const unitByGroup: Record<string, string> = {
        comprimido: "comprimidos",
        capsula: "capsulas",
        gotas: "frasco",
        "solucao oral": "frasco",
        "suspensao oral": "frasco",
        xarope: "frasco",
        pomada: "unidade",
        creme: "unidade",
        gel: "unidade",
        spray: "unidade",
      };
      const unit = unitByGroup[group] || "unidades";

      if (unit === "frasco" || unit === "unidade") {
        return `${packageInfo.unitCount} ${unit}`;
      }

      return `caixa com ${packageInfo.unitCount} ${unit}`;
    }

    if (packageInfo?.volumeMl) {
      return `frasco com ${packageInfo.volumeMl} ml`;
    }

    if (presentation.package_quantity && group !== "outro") {
      return this.formatPackageDescription(presentation, {
        formGroup: group,
        unitCount: presentation.package_quantity,
        isHospitalUse: false,
        isInjectable: false,
        isLargePackage: presentation.package_quantity >= 50,
      });
    }

    if (!presentation.package_description) {
      return undefined;
    }

    return this.humanizePackageDescription(presentation.package_description);
  }

  private humanizePackageDescription(value: string) {
    return value
      .toLowerCase()
      .replace(/\bcx\b/g, "caixa")
      .replace(/\bcom\b/g, "com")
      .replace(/\bcomp\b/g, "comprimidos")
      .replace(/\bcaps\b/g, "capsulas")
      .replace(/\bfr\b/g, "frasco")
      .replace(/\s+/g, " ")
      .trim();
  }

  private presentationText(presentation: BulaApiPresentation) {
    return [
      presentation.dose_form,
      presentation.route,
      presentation.strength,
      presentation.package_description,
    ]
      .filter(Boolean)
      .join(" ");
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`BulAPI respondeu ${response.status} em ${url}`);
    }

    return (await response.json()) as T;
  }

  private getBaseUrl() {
    return (
      this.configService.get<string>("BULA_API_BASE_URL") ||
      "https://bulapi.com.br/api/v1"
    ).replace(/\/$/, "");
  }

  private getCommercialQueryTerms(medicineName: string) {
    const normalized = this.selector.getCanonicalMedicineName(medicineName);
    const terms = [medicineName, normalized];

    if (normalized === "dipirona") {
      terms.push("novalgina", "dipirona generico", "dipirona monoidratada");
    }

    if (normalized === "ibuprofeno") {
      terms.push("ibuprofeno generico", "alivium", "advil");
    }

    if (normalized === "paracetamol") {
      terms.push("paracetamol generico", "tylenol");
    }

    return [...new Set(terms)];
  }

  private productMatchesMedicine(
    product: BulaApiProduct,
    medicineName: string,
  ) {
    return this.selector.isSameMedicine(medicineName, product);
  }

  private cleanMedicineName(value?: string) {
    if (!value) {
      return null;
    }

    const extracted = this.normalizeMedicineName(value);

    if (extracted) {
      return extracted;
    }

    const cleaned = this.normalize(value)
      .replace(
        /\b(por favor|pfv|pra mim|para mim|remedio|medicamento)\b/gi,
        " ",
      )
      .replace(/\s+/g, " ")
      .trim();

    return cleaned.length >= 3 ? cleaned : null;
  }

  private detectCommercialIntent(message: string): MedicineIntent | null {
    const normalized = this.normalize(message);

    if (/\b(preco|valor|quanto custa)\b/.test(normalized)) {
      return "price";
    }

    if (
      /\b(tem|teria|vende|vendem|quero|queria|preciso|gostaria de|adicionar|mais)\b/.test(
        normalized,
      )
    ) {
      return "purchase";
    }

    return null;
  }

  private detectBareMedicineName(value: string) {
    const cleaned = this.cleanMedicineName(value);
    const stopWords = new Set([
      "oi",
      "ola",
      "bom dia",
      "boa tarde",
      "boa noite",
      "obrigado",
      "obrigada",
      "sim",
      "nao",
      "qual valor",
      "preco",
      "valor",
    ]);

    if (!cleaned || stopWords.has(cleaned)) {
      return null;
    }

    const words = cleaned.split(/\s+/);
    return words.length <= 3 ? cleaned : null;
  }

  private formatCurrency(value: number | undefined) {
    if (value === undefined) {
      return "";
    }

    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
    }).format(value);
  }

  private rankProducts(products: BulaApiProduct[], medicineName: string) {
    return [...products].sort((a, b) => {
      const scoreA = this.getProductScore(a, medicineName);
      const scoreB = this.getProductScore(b, medicineName);
      return scoreB - scoreA;
    });
  }

  private getProductScore(product: BulaApiProduct, target: string) {
    return this.selector.getProductScore(product, target);
  }

  private getProductSelectionReason(
    product: BulaApiProduct,
    medicineName: string,
  ) {
    return this.selector.getProductSelectionReason(product, medicineName);
  }

  private productNameScore(productName: string) {
    const normalized = this.normalize(productName);

    if (normalized.includes("novalgina")) return 900;
    if (normalized === "dipirona" || normalized.includes("dipirona"))
      return 160;
    if (normalized.includes("lqfex")) return -120;

    return 0;
  }

  private strengthScore(strength?: string) {
    const normalized = this.normalize(strength || "");

    if (/\b500\s*mg\b/.test(normalized)) return 40;
    if (/\b1\s*g\b/.test(normalized)) return 25;

    return 0;
  }

  private detectBrandPreference(message: string) {
    const normalized = this.normalize(message);

    if (normalized.includes("novalgina")) return "novalgina";
    if (normalized.includes("alivium")) return "alivium";
    if (normalized.includes("advil")) return "advil";
    if (normalized.includes("tylenol")) return "tylenol";

    return null;
  }

  private detectGenericPreference(message: string) {
    return /\bgeneric[oa]?\b/.test(this.normalize(message));
  }

  private isGenericProduct(product: BulaApiProduct) {
    return this.selector.isGenericProduct(product, product.substance?.name || product.name);
  }

  private isGenericProductName(productName: string) {
    const normalized = this.normalize(productName);
    return (
      normalized === "dipirona" ||
      normalized.includes("dipirona sodica") ||
      normalized === "ibuprofeno" ||
      normalized.includes("ibuprofeno ") ||
      normalized === "paracetamol" ||
      normalized.includes("paracetamol ")
    );
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
