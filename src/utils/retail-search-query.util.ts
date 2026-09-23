import { RETAIL_CATEGORY_TERMS, RETAIL_SEARCH_ALIASES } from "../config/retail-search-aliases.config";
import { stripGreetingPrefix } from "./conversation-opening.util";

function fold(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function phrasePattern(value: string, global = false) {
  return new RegExp(`\\b${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, global ? "g" : "");
}

const aliases = Object.entries(RETAIL_SEARCH_ALIASES)
  .flatMap(([canonical, values]) => values.map((alias) => ({ canonical, alias, pattern: phrasePattern(alias, true) })))
  .sort((a, b) => b.alias.length - a.alias.length);

export function normalizeRetailTerms(value: string) {
  let text = fold(value).replace(/\bcom(?=\d)/g, "com ")
    .replace(/\bsempre livres\b/g, "sempre livre")
    .replace(/\babsorventes\b/g, "absorvente")
    .replace(/\bfraldas\b/g, "fralda")
    .replace(/\bunidades\b/g, "unidade");
  for (const { canonical, pattern } of aliases) text = text.replace(pattern, canonical);
  return text
    .replace(/\b(\d+),(\d+)(?=\s*(?:ml|g|kg|l)\b|\s*%)/g, "$1.$2")
    .replace(/\b(\d+(?:\.\d+)?)\s+(ml|g|kg|l)\b/g, "$1$2")
    .replace(/\b(\d+(?:\.\d+)?)(kg|l)\b/g, (_match, value: string, unit: string) => `${Number((Number(value) * 1000).toPrecision(12))}${unit === "kg" ? "g" : "ml"}`)
    .replace(/\b(?:fps|spf)\s*(\d+)\b/g, "fps $1")
    .replace(/\s+/g, " ").trim();
}

export function normalizeRetailSearchQuery(value: string) {
  let text = stripGreetingPrefix(value).replace(/[?!:;]/g, " ").replace(/(?<!\d)[.,]|[.,](?!\d)/g, " ").trim();
  // Only remove conversational prefixes, never words inside a product name.
  for (let step = 0; step < 3; step += 1) {
    text = text.replace(/^(?:eu\s+)?(?:voces?\s+)?(?:gostaria|quero|queria|preciso|tem|teria|teriam|vende|vendem|comprar|compraria|pode ser|pode mandar|quanto custa|qual o preco|qual o valor|qual valor|preco|valor)\b\s*(?:(?:de|do|da|um|uma|o|a)\s+)*/g, "");
  }
  return normalizeRetailTerms(text.replace(/\b(?:por favor|pfv|pra mim|para mim)\b/g, " ").replace(/[.!]+$/, "").trim());
}

export function retailTextContains(text: string, phrase: string) {
  return phrasePattern(normalizeRetailTerms(phrase)).test(normalizeRetailTerms(text));
}

export function explicitRetailCategory(query: string) {
  return explicitRetailCategories(query)[0] || null;
}

export function explicitRetailCategories(query: string) {
  const text = normalizeRetailTerms(query);
  return Object.entries(RETAIL_CATEGORY_TERMS).filter(([category, terms]) => {
    const categoryText = category === "alcool" ? text.replace(/\b(?:sem|com|contem|nao contem)\s+alcool\b/g, " ") : text;
    return terms.some((term) => retailTextContains(categoryText, term));
  }).map(([category]) => category);
}

export function isGenericRetailCategoryQuery(query: string, category: string) {
  const text = normalizeRetailSearchQuery(query);
  return [category, ...(RETAIL_CATEGORY_TERMS[category] || [])].some((term) => normalizeRetailTerms(term) === text);
}

export function extractRetailGtin(query: string) {
  const text = normalizeRetailSearchQuery(query).replace(/^(?:ean|gtin|codigo de barras)\s*/, "");
  if (!/^[\d -]+$/.test(text)) return null;
  const digits = text.replace(/\D/g, "");
  return [8, 12, 13, 14].includes(digits.length) ? digits : null;
}

export function matchesRetailCategory(text: string, category: string) {
  if (category === "gillette") return /\b(?:gillette|prestobarba|barbear|lamina|mach3)\b/.test(normalizeRetailTerms(text));
  return (RETAIL_CATEGORY_TERMS[category] || [category]).some((term) => retailTextContains(text, term));
}

/** Preserve requested model, size and qualifiers without mislabelling them as a brand. */
export function matchesRetailQuery(text: string, query: string, category: string | null) {
  const product = normalizeRetailTerms(text);
  let qualifiers = normalizeRetailSearchQuery(query);
  if (category === "fralda") {
    const adult = /\b(?:adulto|geriatrica|geriatrico)\b/.test(product);
    if (/\b(?:infantil|bebe|crianca|pampers|huggies|pompom|pom pom|mamypoko)\b/.test(qualifiers) && adult) return false;
    if (/\b(?:adulto|geriatrica)\b/.test(qualifiers) && !adult) return false;
    qualifiers = qualifiers.replace(/\b(?:infantil|bebe|crianca|adulto|geriatrica)\b/g, " ");
  }
  for (const term of RETAIL_CATEGORY_TERMS[category || ""] || []) qualifiers = qualifiers.replace(phrasePattern(term, true), " ");
  for (const restriction of ["sem alcool", "sem perfume", "sem fragrancia", "sem abas", "com abas", "sem aba", "com aba"]) {
    if (retailTextContains(qualifiers, restriction) && !retailTextContains(product, restriction)) return false;
  }
  const fps = qualifiers.match(/\bfps (\d+)\b/);
  if (fps && !retailTextContains(product, `fps ${fps[1]}`)) return false;
  const percentages = [...product.matchAll(/\b(\d+(?:\.\d+)?)\s*%/g)].map((match) => Number(match[1]));
  if ([...qualifiers.matchAll(/\b(\d+(?:\.\d+)?)\s*%/g)].some((match) => !percentages.includes(Number(match[1])))) return false;
  if (category === "gillette") {
    if (retailTextContains(query, "aparelho de barbear") && !/\b(?:aparelho|prestobarba)\b/.test(product)) return false;
    if (retailTextContains(query, "lamina de barbear") && !/\blaminas?\b/.test(product)) return false;
  }
  qualifiers = qualifiers.replace(/\b(?:de|do|da|dos|das|o|a|os|as|um|uma|com|para|em|e|tamanho|marca|qualquer)\b/g, " ");
  const tokens = qualifiers.match(/[a-z0-9]+(?:[.-][a-z0-9]+)*/g) || [];
  return tokens.every((token) => retailTextContains(product, token));
}
