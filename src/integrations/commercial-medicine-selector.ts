import { Injectable } from "@nestjs/common";
import { COMMERCIAL_MEDICINES } from "../config/commercial-medicines.config";

export interface SelectorProduct {
  id: number;
  name: string;
  regulatory_category?: string;
  activeIngredient?: string | { name?: string } | null;
  substance?: {
    id?: number;
    name?: string;
  } | null;
  manufacturer?: {
    id?: number;
    name?: string;
  } | null;
}

export interface SelectorPresentation {
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

export interface SelectorOption {
  productName: string;
  medicineName: string;
  formGroup: string;
  strength?: string;
  presentationId: number;
  packageInfo?: PackageInfo;
}

export interface PackageInfo {
  unitCount?: number;
  volumeMl?: number;
  isLargePackage: boolean;
  isHospitalUse: boolean;
  isInjectable: boolean;
  formGroup: string;
}

export interface ParsedMedicineQuery {
  received: string;
  normalized: string;
  medicineName: string | null;
  canonicalName: string | null;
  dosage?: string;
  dosageMg?: number;
  formGroup?: string;
  quantity?: number;
  packageQuantity?: number;
  fallbackTerms: string[];
}

@Injectable()
export class CommercialMedicineSelector {
  private readonly knownSynonyms: Record<string, string> = {
    novalgina: "dipirona",
    dipirona: "dipirona",
    "dipirona sodica": "dipirona",
    "dipirona monoidratada": "dipirona",
    ibuprofeno: "ibuprofeno",
    advil: "ibuprofeno",
    alivium: "ibuprofeno",
    tylenol: "paracetamol",
    paracetamol: "paracetamol",
    loratadina: "loratadina",
    omeprazol: "omeprazol",
    nimesulida: "nimesulida",
    neosulida: "neosulida",
    amoxicilina: "amoxicilina",
    dorflex: "dorflex",
    torsilax: "torsilax",
    neosoro: "neosoro",
    "soro fisiologico nasal": "neosoro",
    cimegripe: "cimegripe",
    buscopan: "buscopan",
    "butilbrometo de escopolamina": "buscopan",
    benegrip: "benegrip",
    engov: "engov",
    luftal: "luftal",
    simeticona: "luftal",
    neosaldina: "neosaldina",
    venvanse: "venvanse",
    tadalafila: "tadalafila",
    tadalafil: "tadalafila",
    tadala: "tadalafila",
    "cloridrato de tadalafila": "tadalafila",
    sildenafila: "sildenafila",
    sildenafil: "sildenafila",
    viagra: "sildenafila",
    "citrato de sildenafila": "sildenafila",
    fexofenadina: "fexofenadina",
    allegra: "fexofenadina",
    "cloridrato de fexofenadina": "fexofenadina",
    ciprofloxacina: "ciprofloxacino",
    ciprofloxacino: "ciprofloxacino",
    "cloridrato de ciprofloxacina": "ciprofloxacino",
    "cloridrato de ciprofloxacino": "ciprofloxacino",
    clonazepam: "clonazepam",
    rivotril: "clonazepam",
    diurix: "hidroclorotiazida",
    hidroclorotiazida: "hidroclorotiazida",
    tamarine: "tamarine",
    plenance: "plenance",
  };

  private readonly brandByMedicine: Record<string, string[]> = {
    dipirona: ["novalgina"],
    ibuprofeno: ["alivium", "advil"],
    paracetamol: ["tylenol"],
    neosulida: ["neosulida"],
    dorflex: ["dorflex"],
    torsilax: ["torsilax"],
    neosoro: ["neosoro", "soro fisiologico nasal"],
    cimegripe: ["cimegripe"],
    buscopan: ["buscopan"],
    benegrip: ["benegrip"],
    engov: ["engov"],
    luftal: ["luftal", "simeticona"],
    neosaldina: ["neosaldina"],
    venvanse: ["venvanse"],
    tadalafila: ["cialis", "tadala"],
    sildenafila: ["viagra"],
    fexofenadina: ["allegra"],
    ciprofloxacino: [],
    clonazepam: ["rivotril"],
    hidroclorotiazida: ["diurix"],
    tamarine: ["tamarine"],
    plenance: ["plenance"],
  };

  normalizeMedicineName(text: string) {
    return this.parseMedicineQuery(text).medicineName;
  }

  parseMedicineQuery(text: string): ParsedMedicineQuery {
    const normalized = this.normalize(text)
      .replace(/[?!:;]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const quantity = this.extractRequestedQuantity(normalized);
    const dosageInfo = this.extractRequestedDosage(normalized);
    const formGroup = this.getPresentationGroupFromText(normalized);
    let cleaned = normalized
      .replace(/[?!:;]/g, " ")
      .replace(/\bnao\s+tem\b/g, " ")
      .replace(/\bnao\s+teria\b/g, " ")
      .replace(/\b(?:pro|para)\s+(?:o\s+|a\s+)?(?:meu|minha)?\s*(?:amigo|amiga|mae|pai|filho|filha|esposa|marido|cliente)\b.*$/g, " ")
      .replace(/\bvoces?\s+(?:tem|teriam|vendem)\b/g, " ")
      .replace(/\bgostaria\s+(?:de|da|do)?\b/g, " ")
      .replace(/\badicionar\b/g, " ")
      .replace(/\bcomprar\b/g, " ")
      .replace(/\bmais\b/g, " ")
      .replace(/\bqual\s+(?:o\s+)?(?:preco|valor)\s+(?:da|do|de)?\b/g, " ")
      .replace(/\b(?:preco|valor)\s+(?:da|do|de)?\b/g, " ")
      .replace(/\bquanto\s+custa\s+(?:a|o|um|uma)?\b/g, " ")
      .replace(
        /\b(?:tem|teria|vende|vendem|quero|queria|preciso)\s+(?:de|da|do)?\b/g,
        " ",
      )
      .replace(/\bquanto\s+custa\b/g, " ")
      .replace(/\b(?:qual|preco|valor)\b/g, " ")
      .replace(/\b(?:por favor|pfv|pra mim|para mim)\b/g, " ")
      .replace(/\b(?:remedios|remedio|medicamentos|medicamento|produto)\b/g, " ")
      .replace(/\b(?:comprimidos?|capsulas?|caixas?|cartelas?|unidades?|unid|frascos?)\b/g, " ")
      .replace(/\b(?:comprimido|capsula|gotas|xarope|solucao|suspensao|pomada|creme|gel|spray|dragea|nasal|oral)\b/g, " ")
      .replace(/\b(?:da|do|de)\b/g, " ")
      .replace(/\b(?:tem|teria|vende|vendem)$/g, " ")
      .replace(/\b(?:cloridrato|citrato|maleato|sulfato|bromidrato|fosfato|monoidratada|monoidratado|sodica|sodico)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (quantity !== undefined) {
      cleaned = cleaned.replace(new RegExp(`^${quantity}\\b`), " ").trim();
    }

    if (dosageInfo.raw) {
      cleaned = cleaned.replace(this.escapeRegExp(dosageInfo.raw), " ").trim();
    }

    cleaned = cleaned
      .replace(/\b\d+(?:[,.]\d+)?\s*(?:mg|g|mcg|ml|mg\/ml)?\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    cleaned = cleaned.replace(/^(?:a|o|um|uma)\s+/g, "").trim();
    const medicineName = cleaned.length >= 2 ? cleaned : null;
    const canonicalName = medicineName
      ? this.resolveCanonicalMedicineName(medicineName)
      : null;
    const fallbackTerms = [
      medicineName,
      canonicalName,
    ]
      .filter((value): value is string => Boolean(value && value.length >= 2))
      .map((value) => this.normalize(value).trim())
      .filter(Boolean);

    return {
      received: text,
      normalized,
      medicineName,
      canonicalName,
      dosage: dosageInfo.normalized,
      dosageMg: dosageInfo.mg,
      formGroup: formGroup === "outro" ? undefined : formGroup,
      quantity,
      packageQuantity: this.extractPackageQuantity(normalized),
      fallbackTerms: [...new Set(fallbackTerms)],
    };
  }

  getCanonicalMedicineName(medicineName: string) {
    const parsed = this.parseMedicineQuery(medicineName);
    const normalized = parsed.medicineName || this.normalize(medicineName);

    return this.resolveCanonicalMedicineName(normalized);
  }

  private resolveCanonicalMedicineName(normalizedMedicineName: string) {
    const normalized = this.normalize(normalizedMedicineName);
    for (const [alias, canonical] of Object.entries(this.knownSynonyms)) {
      if (this.hasWordOrPhrase(normalized, alias)) {
        return canonical;
      }
    }

    return normalized;
  }

  isSameMedicine(query: string, product: SelectorProduct) {
    const canonical = this.getCanonicalMedicineName(query);
    const productText = this.getProductSearchText(product);
    const productName = this.normalize(product.name);
    const substanceName = this.normalize(product.substance?.name || "");
    const brands = this.brandByMedicine[canonical] || [];

    if (
      canonical === "paracetamol" &&
      (productName.includes("sinus") || productName.includes(" dc"))
    ) {
      return false;
    }

    if (
      (productName.includes("+") || substanceName.includes(";")) &&
      !brands.some((brand) => this.hasWordOrPhrase(productName, brand))
    ) {
      return false;
    }

    if (brands.some((brand) => this.hasWordOrPhrase(productText, brand))) {
      return true;
    }

    if (this.hasConflictingKnownMedicine(canonical, productText)) {
      return false;
    }

    if (this.hasWordOrPhrase(productText, canonical)) {
      return true;
    }

    return brands.some((brand) => this.hasWordOrPhrase(productText, brand));
  }

  filterSameMedicine<T extends SelectorProduct>(query: string, products: T[]) {
    const sameMedicine: T[] = [];
    const discarded: T[] = [];

    for (const product of products) {
      if (this.isSameMedicine(query, product)) {
        sameMedicine.push(product);
      } else {
        discarded.push(product);
      }
    }

    return { sameMedicine, discarded };
  }

  isRetailPresentation(presentation: SelectorPresentation) {
    const packageInfo = this.extractPackageInfo(this.presentationText(presentation));

    if (packageInfo.isInjectable || packageInfo.isHospitalUse) {
      return false;
    }

    if (
      packageInfo.unitCount !== undefined &&
      packageInfo.unitCount >= 50 &&
      packageInfo.formGroup !== "outro"
    ) {
      return false;
    }

    return packageInfo.formGroup !== "outro";
  }

  extractPackageInfo(presentationText: string): PackageInfo {
    const text = this.normalize(presentationText);
    const isInjectable =
      /\b(sol inj|inj|injetavel|ampola|amp|iv|im)\b/.test(text);
    const isHospitalUse = /\b(hospitalar|uso hospitalar)\b/.test(text);
    const formGroup = this.getPresentationGroupFromText(text);
    const volumeMatch = text.match(/\b(\d+)\s*ml\b/);
    const unitPatterns = [
      /\b(?:caixa|cx|ct|bl|frasco|fr)?\s*(?:com|x)\s*(\d+)\s*(?:comprimidos?|comp|capsulas?|caps|drageas?|drag)\b/,
      /\b(?:caixa|cx|ct)\s*(\d+)\s*(?:comprimidos?|comp|capsulas?|caps|drageas?|drag)\b/,
      /\b(\d+)\s*(?:unid|unidade|unidades)\b/,
      /\b(?:x|com)\s*(\d+)\b(?!\s*ml)/,
    ];
    let unitCount: number | undefined;

    for (const pattern of unitPatterns) {
      const match = text.match(pattern);

      if (match) {
        unitCount = Number(match[1]);
        break;
      }
    }

    if (unitCount === undefined && /\b(comprim|comp|caps|dragea|drag)\b/.test(text)) {
      const numberMatch = text.match(/\b(\d+)\b/);
      unitCount = numberMatch ? Number(numberMatch[1]) : undefined;
    }

    const volumeMl = volumeMatch ? Number(volumeMatch[1]) : undefined;
    const isLargePackage =
      isHospitalUse ||
      isInjectable ||
      (unitCount !== undefined && unitCount >= 50) ||
      /\bcx\s*(50|60|100)\b/.test(text);

    return {
      unitCount,
      volumeMl,
      isLargePackage,
      isHospitalUse,
      isInjectable,
      formGroup,
    };
  }

  getPresentationGroup(presentation: SelectorPresentation) {
    const text = this.normalize(this.presentationText(presentation));
    return this.getPresentationGroupFromText(text);
  }

  private getPresentationGroupFromText(text: string) {
    if (/\bcomprim|\bcom\b/.test(text)) return "comprimido";
    if (/\bcaps|\bcap\b/.test(text)) return "capsula";
    if (/\bgotas?\b|\bfr got\b/.test(text)) return "gotas";
    if (/\bsolucao oral\b|\bsol oral\b|\bsol or\b|\boral\b/.test(text)) {
      return "solucao oral";
    }
    if (/\bsuspensao oral\b|\bsusp oral\b/.test(text)) return "suspensao oral";
    if (/\bxarope\b/.test(text)) return "xarope";
    if (
      /\bsolucao nasal\b|\bsol nasal\b|\bsol nas\b|\bsoro fisiologico nasal\b|\bnasal\b/.test(
        text,
      )
    ) {
      return "solucao nasal";
    }
    if (/\bpomada\b/.test(text)) return "pomada";
    if (/\bcreme\b/.test(text)) return "creme";
    if (/\bgel\b/.test(text)) return "gel";
    if (/\bspray\b/.test(text)) return "spray";
    if (/\bdragea\b|\bdrg\b/.test(text)) return "dragea";

    return "outro";
  }

  selectCommercialOptions<T extends SelectorOption>(
    medicineName: string,
    options: T[],
  ) {
    const deduped = new Map<string, T>();

    for (const option of options) {
      const key = this.normalize(
        [
          option.productName,
          option.formGroup,
          option.strength,
          option.packageInfo?.unitCount,
          option.packageInfo?.volumeMl,
        ].join("-"),
      );
      const current = deduped.get(key);

      if (
        !current ||
        this.optionScore(medicineName, option) >
          this.optionScore(medicineName, current)
      ) {
        deduped.set(key, option);
      }
    }

    const ranked = [...deduped.values()].sort(
      (a, b) =>
        this.optionScore(medicineName, b) -
        this.optionScore(medicineName, a),
    );
    const parsedQuery = this.parseMedicineQuery(medicineName);

    if (
      parsedQuery.dosageMg !== undefined ||
      parsedQuery.formGroup ||
      parsedQuery.packageQuantity !== undefined
    ) {
      return ranked.slice(0, 3);
    }

    return this.diversifyOptions(medicineName, ranked).slice(0, 3);
  }

  getProductScore(product: SelectorProduct, medicineName: string) {
    const canonical = this.getCanonicalMedicineName(medicineName);
    const text = this.getProductSearchText(product);
    const productName = this.normalize(product.name);
    let score = 0;

    if (this.hasWordOrPhrase(text, canonical)) score += 160;
    if (this.hasCommercialBrand(product, medicineName)) score += 950;
    if (this.isGenericProduct(product, medicineName)) score += 220;

    if (canonical === "dipirona") {
      if (productName.includes("novalgina")) score += 900;
      if (productName.includes("lqfex")) score -= 120;
    }

    if (canonical === "ibuprofeno") {
      if (this.isGenericProduct(product, medicineName)) score += 700;
      if (productName.includes("alivium")) score += 620;
      if (productName.includes("advil")) score += 600;
    }

    if (canonical === "paracetamol") {
      if (this.isGenericProduct(product, medicineName)) score += 700;
      if (productName.includes("tylenol")) score += 620;
    }

    if (
      productName.includes("+") ||
      this.normalize(product.substance?.name || "").includes(";")
    ) {
      score -= 120;
    }

    return score;
  }

  getProductSelectionReason(product: SelectorProduct, medicineName: string) {
    const canonical = this.getCanonicalMedicineName(medicineName);
    const productName = this.normalize(product.name);

    if (canonical === "dipirona" && productName.includes("novalgina")) {
      return "preferência comercial para Dipirona: marca Novalgina";
    }

    if (canonical === "ibuprofeno" && productName.includes("alivium")) {
      return "preferência comercial para Ibuprofeno: marca Alivium";
    }

    if (canonical === "ibuprofeno" && productName.includes("advil")) {
      return "preferência comercial para Ibuprofeno: marca Advil";
    }

    if (canonical === "paracetamol" && productName.includes("tylenol")) {
      return "preferência comercial para Paracetamol: marca Tylenol";
    }

    if (this.hasCommercialBrand(product, medicineName)) {
      return "marca comercial retornada pela PharmaDB";
    }

    if (this.isGenericProduct(product, medicineName)) {
      return "produto genérico de varejo comum";
    }

    return "produto pertence ao medicamento pesquisado";
  }

  isGenericProduct(product: SelectorProduct, medicineName: string) {
    const canonical = this.getCanonicalMedicineName(medicineName);
    const productName = this.normalize(product.name);
    const substanceName = this.normalize(product.substance?.name || "");
    const activeIngredient =
      typeof product.activeIngredient === "string"
        ? this.normalize(product.activeIngredient)
        : this.normalize(product.activeIngredient?.name || "");

    if (this.hasCommercialBrand(product, medicineName)) {
      return false;
    }

    if (product.regulatory_category === "generic") {
      return true;
    }

    return (
      productName === canonical &&
      (substanceName === canonical ||
        activeIngredient === canonical ||
        substanceName.includes(canonical) ||
        activeIngredient.includes(canonical))
    );
  }

  hasCommercialBrand(product: SelectorProduct, medicineName: string) {
    const canonical = this.getCanonicalMedicineName(medicineName);
    const productText = this.getProductSearchText(product);
    const brands = this.brandByMedicine[canonical] || [];

    return brands.some((brand) => this.hasWordOrPhrase(productText, brand));
  }

  private diversifyOptions<T extends SelectorOption>(
    medicineName: string,
    options: T[],
  ) {
    const canonical = this.getCanonicalMedicineName(medicineName);
    const picked: T[] = [];
    const pick = (predicate: (option: T) => boolean) => {
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

    if (canonical === "dipirona") {
      pick(
        (option) =>
          this.optionHasBrand(option, "novalgina") &&
          this.isStrength(option, "500") &&
          option.formGroup === "comprimido",
      );
      pick(
        (option) =>
          this.optionHasBrand(option, "novalgina") &&
          this.isStrength(option, "1g") &&
          option.formGroup === "comprimido",
      );
      pick(
        (option) =>
          this.isGenericOption(option, canonical) &&
          this.isStrength(option, "500") &&
          option.formGroup === "comprimido",
      );
      pick((option) => ["gotas", "solucao oral"].includes(option.formGroup));
    }

    if (canonical === "ibuprofeno") {
      pick(
        (option) =>
          this.isGenericOption(option, canonical) &&
          ["400", "600"].some((strength) => this.isStrength(option, strength)) &&
          ["comprimido", "capsula"].includes(option.formGroup),
      );
      pick(
        (option) =>
          this.optionHasBrand(option, "alivium") &&
          ["400", "600"].some((strength) => this.isStrength(option, strength)),
      );
      pick(
        (option) =>
          this.optionHasBrand(option, "advil") &&
          ["400", "600"].some((strength) => this.isStrength(option, strength)),
      );
      pick((option) =>
        ["suspensao oral", "gotas", "solucao oral"].includes(option.formGroup),
      );
    }

    if (canonical === "paracetamol") {
      pick(
        (option) =>
          this.isGenericOption(option, canonical) &&
          ["500", "750"].some((strength) => this.isStrength(option, strength)) &&
          option.formGroup === "comprimido",
      );
      pick(
        (option) =>
          this.optionHasBrand(option, "tylenol") &&
          ["500", "750"].some((strength) => this.isStrength(option, strength)),
      );
      pick((option) => ["gotas", "solucao oral"].includes(option.formGroup));
    }

    for (const option of options) {
      if (
        !picked.some((item) => item.presentationId === option.presentationId)
      ) {
        picked.push(option);
      }
    }

    return picked;
  }

  private optionScore(optionMedicineName: string, option: SelectorOption) {
    const parsedQuery = this.parseMedicineQuery(optionMedicineName);
    const priority: Record<string, number> = {
      comprimido: 100,
      capsula: 98,
      gotas: 90,
      "solucao oral": 88,
      "suspensao oral": 86,
      xarope: 84,
      "solucao nasal": 83,
      pomada: 82,
      creme: 80,
      gel: 78,
      spray: 76,
      dragea: 74,
    };
    const canonical = this.getCanonicalMedicineName(optionMedicineName);
    const config = COMMERCIAL_MEDICINES[canonical];
    let score = priority[option.formGroup] || 0;

    if (this.optionHasCommercialBrand(option, canonical)) score += 950;
    if (this.isGenericOption(option, canonical)) score += 220;
    if (canonical === "dipirona" && this.optionHasBrand(option, "novalgina")) {
      score += 900;
    }
    if (canonical === "ibuprofeno" && this.optionHasBrand(option, "alivium")) {
      score += 620;
    }
    if (canonical === "ibuprofeno" && this.optionHasBrand(option, "advil")) {
      score += 600;
    }
    if (canonical === "paracetamol" && this.optionHasBrand(option, "tylenol")) {
      score += 620;
    }

    const formIndex = config?.defaultFormOrder.indexOf(
      this.normalizeFormForConfig(option.formGroup),
    );

    if (formIndex !== undefined && formIndex >= 0) {
      score += Math.max(0, 80 - formIndex * 10);
    }

    score += this.strengthScore(canonical, option.strength);
    score += this.packageScore(canonical, option.packageInfo);

    if (
      parsedQuery.dosageMg !== undefined &&
      this.optionMatchesDosageMg(option, parsedQuery.dosageMg)
    ) {
      score += 260;
    }

    if (parsedQuery.formGroup && option.formGroup === parsedQuery.formGroup) {
      score += 130;
    }

    if (
      parsedQuery.packageQuantity !== undefined &&
      option.packageInfo?.unitCount === parsedQuery.packageQuantity
    ) {
      score += 120;
    }

    return score;
  }

  private packageScore(canonical: string, packageInfo?: PackageInfo) {
    if (!packageInfo) {
      return 0;
    }

    const config = COMMERCIAL_MEDICINES[canonical];

    if (packageInfo.isHospitalUse || packageInfo.isInjectable) {
      return -1000;
    }

    if (packageInfo.isLargePackage) {
      return -350;
    }

    if (packageInfo.unitCount === undefined) {
      return packageInfo.volumeMl ? 20 : 0;
    }

    if (config?.preferredSmallPacks.includes(packageInfo.unitCount)) {
      return (
        220 - config.preferredSmallPacks.indexOf(packageInfo.unitCount) * 12
      );
    }

    if (
      config?.maxDefaultPackSize &&
      packageInfo.unitCount <= config.maxDefaultPackSize
    ) {
      return 90 - packageInfo.unitCount;
    }

    return packageInfo.unitCount >= 50 ? -250 : 0;
  }

  private strengthScore(canonical: string, strength?: string) {
    const normalized = this.normalize(strength || "");

    if (canonical === "dipirona" && /\b500\s*mg\b/.test(normalized)) return 45;
    if (canonical === "dipirona" && /\b1\s*g\b/.test(normalized)) return 35;
    if (canonical === "ibuprofeno" && /\b400\s*mg\b/.test(normalized)) return 45;
    if (canonical === "ibuprofeno" && /\b600\s*mg\b/.test(normalized)) return 40;
    if (canonical === "paracetamol" && /\b500\s*mg\b/.test(normalized)) return 45;
    if (canonical === "paracetamol" && /\b750\s*mg\b/.test(normalized)) return 40;

    return 0;
  }

  private isStrength(option: SelectorOption, value: string) {
    const normalized = this.normalize(option.strength || "");

    if (value === "1g") {
      return /\b1\s*g\b|\b1000\s*mg\b/.test(normalized);
    }

    return new RegExp(`\\b${value}\\s*(?:mg|g|mg/ml)?\\b`).test(normalized);
  }

  private optionMatchesDosageMg(option: SelectorOption, requestedMg: number) {
    const text = this.normalize([option.strength, option.packageInfo?.formGroup].join(" "));
    const explicit = text.match(/\b(\d+(?:[,.]\d+)?)\s*(mg\/ml|mg|g)\b/g) || [];

    return explicit.some((match) => {
      const parsed = this.extractRequestedDosage(match);
      return parsed.mg !== undefined && Math.abs(parsed.mg - requestedMg) < 0.01;
    });
  }

  private isGenericOption(option: SelectorOption, canonical: string) {
    const productName = this.normalize(option.productName);

    if (this.optionHasCommercialBrand(option, canonical)) {
      return false;
    }

    return (
      productName === canonical ||
      productName.includes(`${canonical} `) ||
      productName.includes(`${canonical}-`) ||
      productName.includes(`${canonical} sodic`) ||
      productName.includes(`${canonical} monoidratad`)
    );
  }

  private optionHasBrand(option: SelectorOption, brand: string) {
    return this.normalize(option.productName).includes(brand);
  }

  private optionHasCommercialBrand(option: SelectorOption, canonical: string) {
    const brands = this.brandByMedicine[canonical] || [];
    return brands.some((brand) => this.optionHasBrand(option, brand));
  }

  private getProductSearchText(product: SelectorProduct) {
    const activeIngredient =
      typeof product.activeIngredient === "string"
        ? product.activeIngredient
        : product.activeIngredient?.name;

    return this.normalize(
      [
        product.name,
        activeIngredient,
        product.substance?.name,
        product.manufacturer?.name,
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  private presentationText(presentation: SelectorPresentation) {
    return [
      presentation.dose_form,
      presentation.route,
      presentation.strength,
      presentation.package_description,
    ]
      .filter(Boolean)
      .join(" ");
  }

  private hasWordOrPhrase(text: string, phrase: string) {
    const escaped = this.normalize(phrase).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|\\b)${escaped}(\\b|$)`).test(text);
  }

  private hasConflictingKnownMedicine(canonical: string, productText: string) {
    return Object.keys(COMMERCIAL_MEDICINES)
      .filter((medicine) => medicine !== canonical)
      .some((medicine) => {
        const config = COMMERCIAL_MEDICINES[medicine];
        return config.synonyms.some((synonym) =>
          this.hasWordOrPhrase(productText, synonym),
        );
      });
  }

  private normalizeFormForConfig(formGroup: string) {
    return this.normalize(formGroup).toUpperCase();
  }

  private extractRequestedQuantity(normalizedText: string) {
    const explicitMatch = normalizedText.match(
      /^\s*(\d{1,3})\s*(?:unidades?|unid|caixas?|cartelas?|comprimidos?|capsulas?)\b/,
    );

    if (explicitMatch) {
      return Number(explicitMatch[1]);
    }

    const leadingMatch = normalizedText.match(/^\s*(\d{1,2})\s+[a-z]/);

    if (leadingMatch) {
      return Number(leadingMatch[1]);
    }

    return undefined;
  }

  private extractRequestedDosage(normalizedText: string) {
    const explicit = normalizedText.match(
      /\b(\d+(?:[,.]\d+)?)\s*(mg\/ml|mg|mcg|g|ml)\b/,
    );

    if (explicit) {
      const value = Number(explicit[1].replace(",", "."));
      const unit = explicit[2];
      const mg =
        unit === "g"
          ? value * 1000
          : unit === "mg" || unit === "mg/ml"
            ? value
            : undefined;

      return {
        raw: explicit[0],
        normalized: `${this.formatDoseNumber(value)}${unit}`,
        mg,
      };
    }

    const inferredMg = normalizedText.match(/\b(?:de|com)\s*(\d{1,4})\b/);

    if (inferredMg) {
      const value = Number(inferredMg[1]);

      if ([2, 5, 10, 20, 25, 30, 40, 50, 70, 100, 250, 400, 500, 600, 750, 850, 1000].includes(value)) {
        return {
          raw: inferredMg[0],
          normalized: `${value}mg`,
          mg: value,
        };
      }
    }

    return {};
  }

  private extractPackageQuantity(normalizedText: string) {
    const match = normalizedText.match(
      /\b(?:caixa|cx|cartela|ct|bl)\s*(?:com|x)?\s*(\d{1,3})\b/,
    );

    return match ? Number(match[1]) : undefined;
  }

  private formatDoseNumber(value: number) {
    return Number.isInteger(value) ? String(value) : String(value).replace(".", ",");
  }

  private escapeRegExp(value: string) {
    return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  }

  private normalize(value: string) {
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }
}
