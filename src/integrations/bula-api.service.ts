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
  ean?: string | null;
  product?: {
    id: number;
    name: string;
  };
  registration?: {
    registro_ms?: string;
    status?: string;
    expires_at?: string | null;
  } | null;
}

interface BulaApiPrice {
  pf_prices?: Record<string, number | string | null | undefined>;
}

export interface MedicineLookupSummary {
  medicineName: string;
  products: BulaApiProduct[];
  presentations: BulaApiPresentation[];
  highestPfPrice?: number;
}

@Injectable()
export class BulaApiService {
  private readonly logger = new Logger(BulaApiService.name);

  constructor(private readonly configService: ConfigService) {}

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

    return null;
  }

  async buildMedicineReply(question: MedicineQuestion): Promise<string | null> {
    const summary = await this.lookupMedicine(question.medicineName);

    if (!summary) {
      return null;
    }

    if (summary.products.length === 0) {
      return `Nao encontrei "${question.medicineName}" na base de medicamentos. Pode confirmar o nome do remedio ou enviar uma foto da embalagem?`;
    }

    return this.formatMedicineReply(question, summary);
  }

  async lookupMedicine(
    medicineName: string,
  ): Promise<MedicineLookupSummary | null> {
    const baseUrl = this.getBaseUrl();
    this.logger.log(`Chamando BulaAPI para "${medicineName}"`);

    try {
      const search = await this.fetchJson<BulaApiSearchResponse>(
        `${baseUrl}/search?q=${encodeURIComponent(medicineName)}`,
      );
      const directProducts = search.data?.products || [];
      const substances = search.data?.substances || [];
      let products = this.rankProducts(directProducts, medicineName).slice(
        0,
        3,
      );

      if (products.length === 0 && substances[0]) {
        const substanceProducts = await this.fetchJson<
          BulaApiListResponse<BulaApiProduct[]>
        >(`${baseUrl}/substances/${substances[0].id}/products?per_page=3`);
        products = this.rankProducts(
          substanceProducts.data || [],
          medicineName,
        );
      }

      const presentations = await this.getPresentationsForProducts(
        baseUrl,
        products.slice(0, 3),
      );
      const highestPfPrice = await this.getHighestPfPrice(
        baseUrl,
        presentations,
      );

      return {
        medicineName,
        products,
        presentations,
        highestPfPrice,
      };
    } catch (error) {
      this.logger.error(
        `Falha ao consultar BulaAPI para "${medicineName}"`,
        error,
      );
      return null;
    }
  }

  private async getPresentationsForProducts(
    baseUrl: string,
    products: BulaApiProduct[],
  ) {
    const presentations: BulaApiPresentation[] = [];

    for (const product of products) {
      const response = await this.fetchJson<
        BulaApiListResponse<BulaApiPresentation[]>
      >(`${baseUrl}/products/${product.id}/presentations?per_page=3`);

      presentations.push(...(response.data || []));
    }

    return presentations;
  }

  private async getHighestPfPrice(
    baseUrl: string,
    presentations: BulaApiPresentation[],
  ) {
    const pfPrices: number[] = [];

    for (const presentation of presentations) {
      const response = await this.fetchJson<
        BulaApiListResponse<BulaApiPrice[]>
      >(`${baseUrl}/presentations/${presentation.id}/prices`);

      for (const price of response.data || []) {
        for (const value of Object.values(price.pf_prices || {})) {
          const numericValue =
            typeof value === "number"
              ? value
              : Number(String(value).replace(",", "."));

          if (Number.isFinite(numericValue)) {
            pfPrices.push(numericValue);
          }
        }
      }
    }

    return pfPrices.length > 0 ? Math.max(...pfPrices) : undefined;
  }

  private formatMedicineReply(
    question: MedicineQuestion,
    summary: MedicineLookupSummary,
  ) {
    const mainProduct = summary.products[0];
    const substance = mainProduct.substance?.name;
    const manufacturer = mainProduct.manufacturer?.name;
    const category = mainProduct.regulatory_category;
    const presentationLines = summary.presentations
      .slice(0, 3)
      .map((presentation) => this.formatPresentation(presentation))
      .filter(Boolean);
    const priceLine =
      summary.highestPfPrice !== undefined
        ? `Maior preco PF encontrado: ${this.formatCurrency(summary.highestPfPrice)}.`
        : "Nao encontrei preco PF na base consultada.";

    const lines = [
      `Encontrei "${mainProduct.name}" na base Bulapi.`,
      substance ? `Principio ativo: ${substance}.` : null,
      manufacturer ? `Fabricante: ${manufacturer}.` : null,
      category ? `Categoria regulatoria: ${category}.` : null,
      presentationLines.length > 0
        ? `Apresentacoes encontradas: ${presentationLines.join("; ")}.`
        : null,
    ].filter(Boolean) as string[];

    if (question.intent === "price") {
      lines.push(priceLine);
    }

    if (
      ["contraindication", "dosage", "composition", "leaflet"].includes(
        question.intent,
      )
    ) {
      lines.push(
        "Nao vou enviar bula completa por aqui. Para contraindicacoes, composicao e posologia, confirme com o farmaceutico ou com a bula oficial da embalagem, especialmente em caso de alergia, gestacao, criancas ou uso de outros medicamentos.",
      );
    }

    if (question.intent === "purchase") {
      lines.push(
        "Se quiser, me diga a dosagem e a apresentacao desejada para eu ajudar a separar a opcao correta.",
      );
    }

    return lines.join("\n");
  }

  private formatPresentation(presentation: BulaApiPresentation) {
    const details = [
      presentation.strength,
      presentation.dose_form,
      presentation.route,
      presentation.package_quantity
        ? `${presentation.package_quantity} unidade(s)`
        : null,
      presentation.package_description,
    ].filter((detail) => detail && detail !== "unknown" && detail !== "outro");

    return details.join(" ");
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`BulaAPI respondeu ${response.status} em ${url}`);
    }

    return (await response.json()) as T;
  }

  private getBaseUrl() {
    return (
      this.configService.get<string>("BULA_API_BASE_URL") ||
      "https://bulapi.com.br/api/v1"
    ).replace(/\/$/, "");
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
      .replace(/\b(comprimido|capsula|gotas|xarope|solucao|mg|ml)\b.*$/i, " ")
      .replace(/\s+/g, " ")
      .trim();

    return cleaned.length >= 3 ? cleaned : null;
  }

  private formatCurrency(value: number) {
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

    if (productName === target) {
      score += 100;
    }

    if (substanceName === target) {
      score += 80;
    }

    if (productName.includes(target)) {
      score += 30;
    }

    if (substanceName.includes(target)) {
      score += 20;
    }

    if (productName.includes("+") || substanceName.includes(";")) {
      score -= 15;
    }

    return score;
  }

  private normalize(value: string) {
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }
}
