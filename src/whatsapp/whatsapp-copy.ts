import { CommercialMedicineOption } from "../integrations/bula-api.service";

export interface CartSummaryItem {
  name: string;
  quantity: number;
  total?: number;
}

const KNOWN_BRANDS: Record<string, string> = {
  kerastase: "Kérastase",
  "kérastase": "Kérastase",
  seda: "Seda",
  pantene: "Pantene",
  dove: "Dove",
  clear: "Clear",
  elseve: "Elseve",
  rexona: "Rexona",
  nivea: "Nivea",
  colgate: "Colgate",
  "oral-b": "Oral-B",
  "oral b": "Oral-B",
  dorflex: "Dorflex",
  neosoro: "Neosoro",
  novalgina: "Novalgina",
  advil: "Advil",
  alivium: "Alivium",
  huggies: "Huggies",
  pampers: "Pampers",
  mamypoko: "MamyPoko",
  "mamy poko": "MamyPoko",
  johnson: "Johnson",
  granado: "Granado",
  protex: "Protex",
  lux: "Lux",
  palmolive: "Palmolive",
  sensodyne: "Sensodyne",
  closeup: "Closeup",
  always: "Always",
  intimus: "Intimus",
  gillette: "Gillette",
  prestobarba: "Prestobarba",
  mach3: "Mach3",
  bic: "Bic",
  bozzano: "Bozzano",
  vichy: "Vichy",
  cetaphil: "Cetaphil",
  neutrogena: "Neutrogena",
  eucerin: "Eucerin",
  bioderma: "Bioderma",
  isdin: "ISDIN",
};

const COMMON_DISPLAY_WORDS: Record<string, string> = {
  lenco: "Lenço",
  algodao: "Algodão",
  lamina: "Lâmina",
  laminas: "Lâminas",
  cosmetico: "Cosmético",
  cosmeticos: "Cosméticos",
  antisseptico: "Antisséptico",
  solucao: "Solução",
  suspensao: "Suspensão",
  capsula: "Cápsula",
  capsulas: "Cápsulas",
  dragea: "Drágea",
  drageas: "Drágeas",
  generico: "Genérico",
  fps: "FPS",
};

const CATEGORY_WORDS = [
  "shampoo",
  "condicionador",
  "sabonete",
  "desodorante",
  "creme dental",
  "pasta de dente",
  "escova de dente",
  "fio dental",
  "enxaguante bucal",
  "absorvente",
  "fralda",
  "lenço umedecido",
  "lenco umedecido",
  "algodão",
  "algodao",
  "cotonete",
  "aparelho de barbear",
  "lâmina de barbear",
  "lamina de barbear",
  "protetor solar",
  "hidratante",
];

export const WhatsappCopy = {
  resetConversation() {
    return "Conversa reiniciada. Como posso ajudar você hoje?";
  },

  askRetailBrand(category: string, brands: string[]) {
    const lines = [
      "Claro 😊 Você tem alguma marca de preferência?",
      "",
      "Opções comuns:",
    ];

    brands.slice(0, 5).forEach((brand, index) => {
      lines.push(`${index + 1}. ${brand}`);
    });

    lines.push(`${Math.min(brands.length, 5) + 1}. Qualquer marca`);
    lines.push("", "Responda com o número ou o nome da marca.");

    return lines.join("\n");
  },

  showRetailOptions(
    category: string | undefined,
    brand: string | undefined,
    options: CommercialMedicineOption[],
    formatCurrency: (value: number | undefined) => string,
  ) {
    const title = uniqueDisplayParts([category, brand]).join(" ");
    const lines = [
      `Encontrei estas opções${title ? ` de ${title}` : ""}:`,
      "",
    ];

    options.slice(0, 3).forEach((option) => {
      lines.push(
        `${option.optionId}. ${formatProductDisplayName(option.label)} - ${formatCurrency(option.pricePf)}`,
      );
    });

    lines.push("", "Qual opção você prefere?");
    return lines.join("\n");
  },

  confirmRetailSelection(
    product: CommercialMedicineOption,
    formatCurrency: (value: number | undefined) => string,
  ) {
    const lines = [
      "Perfeito, separei para você:",
      "",
      formatProductDisplayName(product.label),
    ];

    if (this.shouldShowPackage(product)) {
      lines.push(`Embalagem: ${formatProductDisplayName(product.packageDescription || "")}`);
    }

    lines.push(
      `Valor: ${formatCurrency(product.pricePf)}`,
      "",
      this.askQuantity(),
    );

    return lines.join("\n");
  },

  confirmMedicineSelection(
    product: CommercialMedicineOption,
    formatCurrency: (value: number | undefined) => string,
  ) {
    const lines = [
      "Perfeito, separei para você:",
      "",
      formatProductDisplayName(product.label),
    ];

    if (this.shouldShowPackage(product)) {
      lines.push(`Embalagem: ${formatProductDisplayName(product.packageDescription || "")}`);
    }

    if (product.pricePf !== undefined) {
      lines.push(`Valor: ${formatCurrency(product.pricePf)}`);
    }

    lines.push("", this.askQuantity());
    return lines.join("\n");
  },

  addedToCart(
    item: CartSummaryItem,
    cartSubtotal: number,
    formatCurrency: (value: number | undefined) => string,
  ) {
    const lines = [
      "Adicionado ao carrinho ✅",
      "",
      `${item.quantity}x ${formatProductDisplayName(item.name)}`,
      `Subtotal: ${formatCurrency(item.total)}`,
    ];

    if (cartSubtotal > (item.total || 0)) {
      lines.push("", `Subtotal do carrinho: ${formatCurrency(cartSubtotal)}`);
    }

    lines.push("", this.askAddMoreOrCheckout());
    return lines.join("\n");
  },

  askAddMoreOrCheckout() {
    return [
      "Deseja:",
      "",
      "1. Adicionar mais produtos",
      "2. Calcular entrega e finalizar pedido",
    ].join("\n");
  },

  showSimilarOffer(category: string, brand?: string) {
    const categoryText = formatProductDisplayName(category);
    const brandText = brand ? ` de ${formatProductDisplayName(brand)}` : "";

    return [
      `No momento encontrei só essas opções${brandText}.`,
      "",
      `Posso te mostrar opções similares de ${categoryText}?`,
      "",
      "1. Sim",
      "2. Não",
    ].join("\n");
  },

  productNotFound(productName: string) {
    return `No momento não localizei ${formatProductDisplayName(productName)} disponível. Pode confirmar o nome ou enviar outra opção?`;
  },

  medicineNotFound() {
    return "No momento não localizei esse medicamento. Pode conferir o nome ou me enviar uma foto da embalagem?";
  },

  askQuantity() {
    return "Quantas unidades deseja?";
  },

  askCep() {
    return "Perfeito. Qual o CEP para entrega?";
  },

  askAddressNumber(address: string) {
    return `Encontrei: ${address}.\nQual o número do endereço?`;
  },

  orderConfirmation(
    cartLines: string,
    subtotal: number,
    _deliveryFee: number,
    address: string,
    formatCurrency: (value: number | undefined) => string,
  ) {
    return [
      "Resumo do pedido:",
      "",
      cartLines,
      "",
      `Subtotal: ${formatCurrency(subtotal)}`,
      "Entrega: grátis",
      "Prazo estimado: até 30 minutos",
      `Total: ${formatCurrency(subtotal)}`,
      "",
      "Endereço:",
      address,
      "",
      "Confirma o pedido?",
      "",
      "1. Confirmar",
      "2. Adicionar mais produtos",
      "3. Cancelar",
    ].join("\n");
  },

  shouldShowPackage(product: CommercialMedicineOption) {
    if (!product.packageDescription) {
      return false;
    }

    return (
      normalizeText(product.packageDescription) !== normalizeText(product.label)
    );
  },
};

export function formatProductDisplayName(name: string) {
  const cleaned = removeRepeatedWords(
    name
      .replace(/\s+/g, " ")
      .replace(/\bgen[eé]rico\b/gi, "")
      .trim(),
  );
  const titleCased = cleaned
    .toLowerCase()
    .split(" ")
    .map((word) => formatDisplayWord(word))
    .join(" ")
    .replace(/\b(\d+)\s?(mg|g|ml|un|und|kg)\b/gi, (_, value, unit) => {
      return `${value}${unit.toLowerCase()}`;
    })
    .replace(/\b(Com|De|Da|Do|Das|Dos|E)\b/g, (word) => word.toLowerCase())
    .replace(/\bAnti Usure\b/g, "Anti-Usure")
    .replace(/\s+/g, " ")
    .trim();

  return reorderCategoryBrand(titleCased);
}

function formatDisplayWord(word: string): string {
  const normalized = normalizeText(word);
  const brand = KNOWN_BRANDS[normalized];

  if (brand) {
    return brand;
  }

  const commonWord = COMMON_DISPLAY_WORDS[normalized];

  if (commonWord) {
    return commonWord;
  }

  if (/^\d+(mg|g|ml|un|und|kg)$/i.test(word)) {
    return word.toLowerCase();
  }

  if (word.includes("-")) {
    return word
      .split("-")
      .map((part) => formatDisplayWord(part))
      .join("-");
  }

  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function reorderCategoryBrand(value: string) {
  const normalized = normalizeText(value);

  for (const category of CATEGORY_WORDS) {
    const normalizedCategory = normalizeText(category);

    for (const brand of Object.values(KNOWN_BRANDS)) {
      const normalizedBrand = normalizeText(brand);
      const prefix = `${normalizedCategory} ${normalizedBrand}`;

      if (normalized.startsWith(prefix)) {
        const rest = value.slice(prefix.length).trim();
        const restHasDescriptor =
          rest.length > 0 && !/^\d+\s?(mg|g|ml|un|und|kg)$/i.test(rest);

        if (!restHasDescriptor) {
          return limitDisplayName(value);
        }

        const categoryDisplay = formatProductDisplayNameWithoutReorder(category);
        return [brand, rest, categoryDisplay]
          .filter(Boolean)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
      }
    }
  }

  return limitDisplayName(value);
}

function formatProductDisplayNameWithoutReorder(name: string) {
  return name
    .toLowerCase()
    .split(" ")
    .map((word) => formatDisplayWord(word))
    .join(" ");
}

function removeRepeatedWords(value: string) {
  const words = value.split(" ");
  const result: string[] = [];

  for (const word of words) {
    if (normalizeText(result[result.length - 1] || "") !== normalizeText(word)) {
      result.push(word);
    }
  }

  return result.join(" ");
}

function limitDisplayName(value: string) {
  if (value.length <= 80) {
    return value;
  }

  const sizeMatch = value.match(/\b\d+\s?(mg|g|ml|un|und|kg)\b/i);
  const suffix = sizeMatch ? ` ${sizeMatch[0].replace(/\s+/g, "")}` : "";
  const base = value.slice(0, 72 - suffix.length).trim();

  return `${base}${suffix}`;
}

function uniqueDisplayParts(values: Array<string | undefined>) {
  const seen = new Set<string>();
  const parts: string[] = [];

  for (const value of values) {
    if (!value) {
      continue;
    }

    const display = formatProductDisplayName(value);
    const normalized = normalizeText(display);

    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    parts.push(display);
  }

  return parts;
}

function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}
