import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

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

interface BulaApiProduct {
  id: number;
  name: string;
  regulatory_category?: string;
  substance?: {
    id: number;
    name: string;
  };
  manufacturer?: {
    id: number;
    name: string;
  };
}

interface BulaApiPresentation {
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

  constructor(private readonly configService: ConfigService) {}

  isPriceQuestionWithoutMedicine(message: string) {
    const normalized = this.normalize(message).trim();
    return (
      /^(qual\s+)?(preco|valor)(\?)?$/.test(normalized) ||
      /^quanto\s+custa(\?)?$/.test(normalized)
    );
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
          /\bpreciso\s+(?:de|da|do)?\s*(.+)$/i,
          /\bvoces tem\s+(.+)$/i,
          /\btem\s+(.+)$/i,
        ],
      },
    ];

    for (const { intent, patterns } of intentPatterns) {
      for (const pattern of patterns) {
        const match = compact.match(pattern);
        const medicineName = this.cleanMedicineName(match?.[1]);

        if (medicineName) {
          return { intent, medicineName };
        }
      }
    }

    const bareMedicine = this.detectBareMedicineName(compact);
    return bareMedicine
      ? { intent: "purchase", medicineName: bareMedicine }
      : null;
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
      this.logger.log(
        `Produtos retornados pela busca: ${products.map((product) => product.name).join(", ") || "nenhum"}`,
      );

      const selection = this.selectCommercialProduct(medicineName, products);

      if (selection) {
        this.logger.log(
          `Produto comercial selecionado: ${selection.product.name}. Motivo da selecao: ${selection.reason}`,
        );
      }

      const options = await this.getCommercialOptions(
        baseUrl,
        medicineName,
        products,
      );
      this.logger.log(`Opcoes filtradas: ${options.length}`);

      return {
        medicineName,
        products,
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
      score: this.getProductScore(product, this.normalize(medicineName)),
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

  formatNotFound(medicineName: string) {
    return `Nao encontrei "${medicineName}" na base de medicamentos. Pode confirmar o nome do remedio ou enviar uma foto da embalagem?`;
  }

  formatPresentationChoiceReply(summary: MedicineLookupSummary) {
    if (summary.options.length === 0) {
      return `Encontrei ${this.title(summary.products[0]?.name || summary.medicineName)}, mas nao achei apresentacoes comuns de varejo. Pode me dizer se voce quer comprimido, gotas, capsula ou xarope?`;
    }

    if (summary.options.length === 1) {
      const option = summary.options[0];
      return [
        `Encontrei ${this.title(option.productName)} ${option.label}.`,
        option.pricePf
          ? `Valor: ${this.formatCurrency(option.pricePf)}.`
          : "Nao encontrei preco regulado para essa apresentacao.",
        "",
        "Quantas unidades voce deseja?",
      ].join("\n");
    }

    const lines = [
      `Encontrei ${this.title(summary.medicineName)}. Qual apresentacao voce deseja?`,
      "",
    ];

    for (const option of summary.options.slice(0, 3)) {
      lines.push(
        `${option.optionId}. ${this.title(option.productName)} ${option.label}`,
      );
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
      const option = summary.options[0];
      return [
        `Encontrei ${this.title(option.productName)} ${option.label}.`,
        option.pricePf
          ? `Valor: ${this.formatCurrency(option.pricePf)}.`
          : "Nao encontrei preco regulado para essa apresentacao.",
        "",
        "Quantas unidades voce deseja?",
      ].join("\n");
    }

    const lines = [
      `Encontrei algumas opcoes de ${this.title(summary.medicineName)}:`,
      "",
    ];

    for (const option of summary.options.slice(0, 3)) {
      lines.push(
        `${option.optionId}. ${this.title(option.productName)} ${option.label}`,
      );
    }

    lines.push("", "Qual voce prefere?");
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
        this.isGenericProductName(option.productName),
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
        if (this.productMatchesMedicine(product, medicineName)) {
          productMap.set(product.id, product);
        }
      }

      const substance = search.data?.substances?.find((item) =>
        this.normalize(item.name).includes(this.normalize(medicineName)),
      );

      if (substance) {
        const substanceProducts = await this.fetchJson<
          BulaApiListResponse<BulaApiProduct[]>
        >(`${baseUrl}/substances/${substance.id}/products?per_page=20`);

        for (const product of substanceProducts.data || []) {
          if (this.productMatchesMedicine(product, medicineName)) {
            productMap.set(product.id, product);
          }
        }
      }
    }

    return this.rankProducts([...productMap.values()], medicineName).slice(
      0,
      16,
    );
  }

  private async getCommercialOptions(
    baseUrl: string,
    medicineName: string,
    products: BulaApiProduct[],
  ) {
    const options: CommercialMedicineOption[] = [];

    for (const product of products) {
      const productSelection = this.selectCommercialProduct(medicineName, [
        product,
      ]);
      const response = await this.fetchJson<
        BulaApiListResponse<BulaApiPresentation[]>
      >(`${baseUrl}/products/${product.id}/presentations?per_page=30`);

      for (const presentation of response.data || []) {
        if (!this.isRetailPresentation(presentation)) {
          continue;
        }

        const pricePf = await this.getHighestPfForSelectedProduct(
          baseUrl,
          product,
          presentation,
        );
        options.push({
          optionId: 0,
          productId: product.id,
          presentationId: presentation.id,
          productName: product.name,
          medicineName: product.substance?.name || product.name,
          label: this.formatOptionLabel(presentation),
          formGroup: this.getPresentationGroup(presentation),
          strength: presentation.strength,
          pricePf,
          selectionReason: productSelection?.reason,
        });
      }
    }

    return this.rankOptions(options, medicineName)
      .slice(0, 6)
      .map((option, index) => ({ ...option, optionId: index + 1 }));
  }

  private isRetailPresentation(presentation: BulaApiPresentation) {
    const text = this.normalize(this.presentationText(presentation));

    if (
      /\b(sol inj|inj|injetavel|ampola|amp|iv|im|hospitalar|uso hospitalar)\b/.test(
        text,
      ) ||
      /cx\s*(50|100)\b/.test(text) ||
      /x\s*(50|100|240)\b/.test(text)
    ) {
      return false;
    }

    return this.getPresentationGroup(presentation) !== "outro";
  }

  private rankOptions(
    options: CommercialMedicineOption[],
    medicineName: string,
  ) {
    const deduped = new Map<string, CommercialMedicineOption>();

    for (const option of options) {
      const key = this.normalize(
        `${option.productName}-${option.formGroup}-${option.strength}`,
      );
      const current = deduped.get(key);

      if (!current || this.optionScore(option) > this.optionScore(current)) {
        deduped.set(key, option);
      }
    }

    const ranked = [...deduped.values()].sort(
      (a, b) => this.optionScore(b) - this.optionScore(a),
    );

    if (this.normalize(medicineName).includes("dipirona")) {
      return this.diversifyDipironaOptions(ranked);
    }

    return ranked;
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
    const group = this.getPresentationGroup(presentation);
    const details = [this.title(group), presentation.strength]
      .filter((item) => item && item !== "unknown")
      .join(" ");

    return details || this.title(group);
  }

  private getPresentationGroup(presentation: BulaApiPresentation) {
    const text = this.normalize(this.presentationText(presentation));

    if (/\bcomprim/.test(text)) return "comprimido";
    if (/\bcaps/.test(text)) return "capsula";
    if (/\bgotas?\b|\bfr got\b/.test(text)) return "gotas";
    if (/\bsolucao oral\b|\bsol oral\b|\bsol or\b|\boral\b/.test(text))
      return "solucao oral";
    if (/\bsuspensao oral\b|\bsusp oral\b/.test(text)) return "suspensao oral";
    if (/\bxarope\b/.test(text)) return "xarope";
    if (/\bpomada\b/.test(text)) return "pomada";
    if (/\bcreme\b/.test(text)) return "creme";
    if (/\bgel\b/.test(text)) return "gel";
    if (/\bspray\b/.test(text)) return "spray";

    return "outro";
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
    const normalized = this.normalize(medicineName);
    const terms = [medicineName];

    if (normalized.includes("dipirona")) {
      terms.push("novalgina", "dipirona generico", "dipirona monoidratada");
    }

    return [...new Set(terms)];
  }

  private productMatchesMedicine(
    product: BulaApiProduct,
    medicineName: string,
  ) {
    const target = this.normalize(medicineName);
    const productName = this.normalize(product.name);
    const substanceName = this.normalize(product.substance?.name || "");

    if (target.includes("dipirona")) {
      return (
        substanceName.includes("dipirona") || productName.includes("novalgina")
      );
    }

    return productName.includes(target) || substanceName.includes(target);
  }

  private cleanMedicineName(value?: string) {
    if (!value) {
      return null;
    }

    const cleaned = value
      .replace(
        /\b(por favor|pfv|pra mim|para mim|remedio|medicamento)\b/gi,
        " ",
      )
      .replace(/\s+/g, " ")
      .trim();

    return cleaned.length >= 3 ? cleaned : null;
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
    const target = this.normalize(medicineName);

    return [...products].sort((a, b) => {
      const scoreA = this.getProductScore(a, target);
      const scoreB = this.getProductScore(b, target);
      return scoreB - scoreA;
    });
  }

  private getProductScore(product: BulaApiProduct, target: string) {
    const productName = this.normalize(product.name);
    const substanceName = this.normalize(product.substance?.name || "");
    let score = 0;

    if (target.includes("dipirona")) {
      if (productName.includes("novalgina")) score += 900;
      if (this.isGenericProduct(product)) score += 220;
      if (productName === "dipirona" || productName.includes("dipirona")) {
        score += 160;
      }
      if (productName.includes("lqfex")) score -= 120;
    }

    if (productName === target) score += 100;
    if (substanceName === target) score += 80;
    if (productName.includes(target)) score += 30;
    if (substanceName.includes(target)) score += 20;
    if (productName.includes("+") || substanceName.includes(";")) score -= 80;

    return score;
  }

  private getProductSelectionReason(
    product: BulaApiProduct,
    medicineName: string,
  ) {
    const productName = this.normalize(product.name);
    const target = this.normalize(medicineName);

    if (target.includes("dipirona") && productName.includes("novalgina")) {
      return "preferencia comercial para Dipirona: marca Novalgina";
    }

    if (this.isGenericProduct(product)) {
      return "produto generico de varejo comum";
    }

    if (productName.includes(target)) {
      return "nome do produto corresponde ao medicamento buscado";
    }

    return "melhor pontuacao comercial disponivel";
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

    return null;
  }

  private detectGenericPreference(message: string) {
    return /\bgeneric[oa]?\b/.test(this.normalize(message));
  }

  private isGenericProduct(product: BulaApiProduct) {
    return (
      product.regulatory_category === "generic" ||
      this.isGenericProductName(product.name)
    );
  }

  private isGenericProductName(productName: string) {
    const normalized = this.normalize(productName);
    return normalized === "dipirona" || normalized.includes("dipirona sodica");
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
