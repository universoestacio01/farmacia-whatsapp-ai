import { NormalizedRetailProduct } from "../integrations/product-provider.interface";

export type RetailPriceSource =
  | "cosmos_avg_price"
  | "cosmos_max_price"
  | "cosmos_price_string"
  | "default_category_price"
  | "premium_brand_price";

export interface RetailSalePriceResult {
  price: number;
  source: RetailPriceSource;
}

export const RETAIL_DEFAULT_PRICES: Record<string, number> = {
  sabonete: 4.99,
  shampoo: 18.9,
  condicionador: 19.9,
  desodorante: 13.9,
  creme_dental: 7.99,
  escova_dente: 8.99,
  fio_dental: 9.9,
  enxaguante_bucal: 19.9,
  absorvente: 11.9,
  fralda: 39.9,
  lenco_umedecido: 12.9,
  algodao: 6.9,
  cotonete: 6.9,
  gillette: 9.9,
  aparelho_barbear: 9.9,
  lamina_barbear: 19.9,
  protetor_solar: 39.9,
  hidratante: 24.9,
  cosmetico: 29.9,
  default: 14.9,
};

export const RETAIL_PREMIUM_BRANDS = [
  "kerastase",
  "kérastase",
  "la roche",
  "vichy",
  "cetaphil",
  "neutrogena",
  "eucerin",
  "bioderma",
  "isdin",
];

export const RETAIL_PREMIUM_PRICES: Record<string, number> = {
  shampoo: 119.9,
  condicionador: 129.9,
  protetor_solar: 79.9,
  hidratante: 69.9,
  cosmetico: 89.9,
};

export function calculateRetailSalePrice(
  product: Pick<
    NormalizedRetailProduct,
    | "avgPrice"
    | "maxPrice"
    | "referencePrice"
    | "productName"
    | "displayName"
    | "description"
    | "brand"
    | "category"
    | "gpcDescription"
  >,
  multiplier = 1,
): RetailSalePriceResult {
  const safeMultiplier =
    Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;

  const avgPrice = product.avgPrice;
  const maxPrice = product.maxPrice;
  const referencePrice = product.referencePrice;

  if (isPositivePrice(avgPrice)) {
    return {
      price: roundCurrency(avgPrice * safeMultiplier),
      source: "cosmos_avg_price",
    };
  }

  if (isPositivePrice(maxPrice)) {
    return {
      price: roundCurrency(maxPrice * safeMultiplier),
      source: "cosmos_max_price",
    };
  }

  if (isPositivePrice(referencePrice)) {
    return {
      price: roundCurrency(referencePrice * safeMultiplier),
      source: "cosmos_price_string",
    };
  }

  const categoryKey = inferRetailCategoryKey(product);

  if (isPremiumProduct(product)) {
    return {
      price: RETAIL_PREMIUM_PRICES[categoryKey] || RETAIL_PREMIUM_PRICES.cosmetico,
      source: "premium_brand_price",
    };
  }

  return {
    price: RETAIL_DEFAULT_PRICES[categoryKey] || RETAIL_DEFAULT_PRICES.default,
    source: "default_category_price",
  };
}

export function inferRetailCategoryKey(
  product: Pick<
    NormalizedRetailProduct,
    "productName" | "displayName" | "description" | "brand" | "category" | "gpcDescription"
  >,
) {
  const text = normalizeRetailText(
    [
      product.productName,
      product.displayName,
      product.description,
      product.brand,
      product.category,
      product.gpcDescription,
    ]
      .filter(Boolean)
      .join(" "),
  );

  if (/\b(condicionador)\b/.test(text)) return "condicionador";
  if (/\b(shampoo|xampu|xampus)\b/.test(text)) return "shampoo";
  if (/\b(sabonete|sabao|saboes)\b/.test(text)) return "sabonete";
  if (/\b(desodorante|antiperspirante)\b/.test(text)) return "desodorante";
  if (/\b(creme dental|pasta de dente|dental)\b/.test(text)) return "creme_dental";
  if (/\b(escova de dente|escova dental)\b/.test(text)) return "escova_dente";
  if (/\b(fio dental)\b/.test(text)) return "fio_dental";
  if (/\b(enxaguante|antisseptico bucal)\b/.test(text)) return "enxaguante_bucal";
  if (/\b(absorvente|always|intimus|carefree)\b/.test(text)) return "absorvente";
  if (/\b(fralda|pampers|huggies|mamy poko)\b/.test(text)) return "fralda";
  if (/\b(lenco umedecido|toalha umedecida|umedecido)\b/.test(text)) {
    return "lenco_umedecido";
  }
  if (/\b(algodao)\b/.test(text)) return "algodao";
  if (/\b(cotonete|hastes flexiveis)\b/.test(text)) return "cotonete";
  if (/\b(aparelho de barbear|prestobarba)\b/.test(text)) return "aparelho_barbear";
  if (/\b(lamina de barbear|laminas)\b/.test(text)) return "lamina_barbear";
  if (/\b(gillette|gilete)\b/.test(text)) return "gillette";
  if (/\b(protetor solar|filtro solar|sundown|isdin)\b/.test(text)) {
    return "protetor_solar";
  }
  if (/\b(hidratante|cetaphil)\b/.test(text)) return "hidratante";
  if (/\b(cosmetico|cosmeticos|vichy|bioderma|eucerin)\b/.test(text)) {
    return "cosmetico";
  }

  return "default";
}

function isPremiumProduct(
  product: Pick<
    NormalizedRetailProduct,
    "productName" | "displayName" | "description" | "brand"
  >,
) {
  const text = normalizeRetailText(
    [product.productName, product.displayName, product.description, product.brand]
      .filter(Boolean)
      .join(" "),
  );

  return RETAIL_PREMIUM_BRANDS.some((brand) =>
    text.includes(normalizeRetailText(brand)),
  );
}

function isPositivePrice(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

function roundCurrency(value: number) {
  return Number(value.toFixed(2));
}

function normalizeRetailText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}
