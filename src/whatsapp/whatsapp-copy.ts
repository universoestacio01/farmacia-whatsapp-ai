import type { CommercialMedicineOption } from "../integrations/bula-api.service";

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
  comprimidos: "comprimidos",
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
    return "Conversa reiniciada. Olá! 😊 O que você precisa hoje?";
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
    lines.push("", "Digite o número ou o nome da marca.");

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
      `Tenho estas opções${title ? ` de ${title}` : ""} para você:`,
      "",
    ];

    options.slice(0, 3).forEach((option) => {
      const price = formatCurrency(option.pricePf);
      lines.push(
        `${option.optionId}. ${formatProductDisplayName(option.label)}${price ? ` - ${price}` : ""}`,
      );
    });

    lines.push("", choicePrompt());
    return lines.join("\n");
  },

  confirmRetailSelection(
    product: CommercialMedicineOption,
    formatCurrency: (value: number | undefined) => string,
  ) {
    const lines = [
      "Perfeito, separei este item para você:",
      "",
      formatProductDisplayName(product.label),
    ];

    if (this.shouldShowPackage(product)) {
      lines.push(
        `Embalagem: ${formatProductDisplayName(product.packageDescription || "")}`,
      );
    }

    const price = formatCurrency(product.pricePf);

    if (price) {
      lines.push(`Valor: ${price}`);
    }

    lines.push("", this.askQuantity());

    return lines.join("\n");
  },

  confirmMedicineSelection(
    product: CommercialMedicineOption,
    formatCurrency: (value: number | undefined) => string,
  ) {
    const lines = [
      "Perfeito, separei este item para você:",
      "",
      formatProductDisplayName(product.label),
    ];

    if (this.shouldShowPackage(product)) {
      lines.push(
        `Embalagem: ${formatProductDisplayName(product.packageDescription || "")}`,
      );
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
      "O que você quer fazer agora?",
      "",
      "1. Adicionar mais produtos",
      "2. Finalizar pedido",
    ].join("\n");
  },

  showSimilarOffer(category: string, brand?: string) {
    const categoryText = formatProductDisplayName(category);
    const brandText = brand ? ` de ${formatProductDisplayName(brand)}` : "";

    return [
      `No momento tenho estas opções${brandText}.`,
      "",
      `Posso te mostrar opções parecidas de ${categoryText}?`,
      "",
      "1. Sim",
      "2. Não",
    ].join("\n");
  },

  productNotFound(_productName: string) {
    return [
      "No momento não encontrei esse produto disponível.",
      "",
      "Posso te mostrar uma opção parecida?",
    ].join("\n");
  },

  medicineNotFound() {
    return [
      "No momento não encontrei esse medicamento disponível.",
      "",
      "Você pode conferir o nome ou me enviar uma foto da embalagem?",
    ].join("\n");
  },

  askQuantity() {
    return "Quantas unidades você quer?";
  },

  askCep() {
    return "Perfeito. Me envie o CEP da entrega, por favor.";
  },

  askAddressNumber(address: string) {
    return `Encontrei: ${address}.\nQual é o número do endereço?`;
  },

  askAddressComplement() {
    return [
      "Tem complemento ou ponto de referência?",
      "",
      "Exemplos:",
      "Apto 302, bloco B, casa azul, próximo ao mercado.",
      "",
      'Se não tiver, responda "não".',
    ].join("\n");
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
      "Prazo: até 30 minutos após a confirmação do pagamento",
      `Total: ${formatCurrency(subtotal)}`,
      "",
      "Endereço:",
      address,
      "",
      "Está tudo certo para confirmar o pedido?",
      "",
      "1. Confirmar pedido",
      "2. Adicionar mais produtos",
      "3. Cancelar",
    ].join("\n");
  },

  shouldShowPackage(product: CommercialMedicineOption) {
    const packageDescription = formatProductDisplayName(
      product.packageDescription || "",
    );

    if (!packageDescription) {
      return false;
    }

    return (
      normalizeText(packageDescription) !== normalizeText(product.label)
    );
  },
};

export function formatProductDisplayName(name: unknown) {
  const sanitized = sanitizeCustomerText(name);

  if (!sanitized) {
    return "";
  }

  const cleaned = removeRepeatedWords(
    sanitized
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
    .replace(/\bCaixa com\b/g, "caixa com")
    .replace(/\bCápsula\b(?=.*\bcaixa com \d+ cápsulas\b)/i, "Cápsulas")
    .replace(/\b(\d+)\s+Cápsulas\b/g, "$1 cápsulas")
    .replace(/\bAnti Usure\b/g, "Anti-Usure")
    .replace(/\s+-\s+/g, " - ")
    .replace(/\s+-\s*$/g, "")
    .replace(/^\s*-\s+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return sanitizeCustomerText(reorderCategoryBrand(titleCased));
}

export function sanitizeCustomerText(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value)
    .replace(/\[object Object\]/gi, "")
    .replace(/\b(?:UNKNOWN|UNDEFINED|NULL|N\/A|NaN)\b/gi, "")
    .replace(/\bcaixa\s+com\s+0\s+(?:unidades|cápsulas|capsulas|comprimidos)\b/gi, "")
    .replace(/\b0\s+(?:cápsulas|capsulas|comprimidos)\b/gi, "")
    .replace(/\bcaixa\s+com\s*$/gi, "")
    .replace(/\bapresentação\s*$/gi, "")
    .replace(/\bdosagem\s*$/gi, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+-\s+-\s+/g, " - ")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+-\s*$/g, "")
    .replace(/^\s*-\s+/g, "")
    .replace(/\bCapsula\b/g, "Cápsula")
    .replace(/\bCapsulas\b/g, "Cápsulas")
    .replace(/\bcapsula\b/g, "cápsula")
    .replace(/\bcapsulas\b/g, "cápsulas")
    .replace(/\bsolucao\b/gi, (match) =>
      match[0] === match[0].toUpperCase() ? "Solução" : "solução",
    )
    .trim();
}

export function choicePrompt() {
  return [
    "Qual delas você quer levar?",
    "",
    "Digite apenas o número da opção.",
  ].join("\n");
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
