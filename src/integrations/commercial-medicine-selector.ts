import { Injectable } from "@nestjs/common";
import { COMMERCIAL_MEDICINES } from "../config/commercial-medicines.config";
import { MedicinePriorityRuleConfig } from "../config/medicine-priority-rules.config";
import { getConversationOpeningIntent, stripGreetingPrefix } from "../utils/conversation-opening.util";
import { extractMedicineStrengths, medicineStrengthMatches, medicineStrengthSignature, removeMedicineStrengths } from "../utils/medicine-strength.util";

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
  label?: string;
  pricePf?: number;
  selectionReason?: string;
  source?: string;
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
  volumeMl?: number;
  sizePreference?: "larger" | "smaller";
  canonicalName: string | null;
  dosage?: string;
  dosageMg?: number;
  formGroup?: string;
  quantity?: number;
  packageQuantity?: number;
  fallbackTerms: string[];
}

interface RankedOption<T extends SelectorOption> {
  option: T;
  score: number;
  category: string;
  reason: string;
  configPriority: number;
  unitPrice?: number;
  totalPrice?: number;
  signature: string;
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
    neopiridin: "neopiridin",
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
    plenance: "rosuvastatina",
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
    loratadina: [],
    omeprazol: [],
    neopiridin: ["neopiridin"],
    venvanse: ["venvanse"],
    tadalafila: ["cialis", "tadala"],
    rosuvastatina: ["plenance"],
    sildenafila: ["viagra"],
    fexofenadina: ["allegra"],
    ciprofloxacino: [],
    clonazepam: ["rivotril"],
    hidroclorotiazida: ["diurix"],
    tamarine: ["tamarine"],
  };

  normalizeMedicineName(text: string) {
    return this.parseMedicineQuery(text).medicineName;
  }

  parseMedicineQuery(text: string): ParsedMedicineQuery {
    const normalized = this.normalize(stripGreetingPrefix(text))
      .replace(/[?!:;]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const quantity = this.extractRequestedQuantity(normalized);
    const dosageInfo = this.extractRequestedDosage(normalized);
    const formGroup = this.getPresentationGroupFromText(normalized.replace(/\bcom\b/g, " "));
    const volume = removeMedicineStrengths(normalized).match(/\b(\d+(?:[,.]\d+)?)\s*ml\b/);
    let cleaned = removeMedicineStrengths(normalized)
      .replace(/[?!:;]/g, " ")
      .replace(/\bnao\s+tem\b/g, " ")
      .replace(/\bnao\s+teria\b/g, " ")
      .replace(/\b(?:pro|para)\s+(?:o\s+|a\s+)?(?:meu|minha)?\s*(?:amigo|amiga|mae|pai|filho|filha|esposa|marido|cliente)\b.*$/g, " ")
      .replace(/\bvoces?\s+(?:tem|teriam|vendem)\b/g, " ")
      .replace(/\bgostaria\s+(?:de|da|do)?\b/g, " ")
      .replace(/\badicionar\b/g, " ")
      .replace(/\bcomprar\b/g, " ")
      .replace(/\b(?:fazer|realizar|montar|iniciar)\s+(?:(?:um|uma|o|a|meu|minha|novo|nova)\s+)*(?:pedido|compra)(?:\s+(?:de|com))?\b/g, " ")
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
      .replace(/\b(?:colirios?|oftalmic[ao]|injetave[l]|injetaveis|pastilhas?)\b/g, " ")
      .replace(/[()[\]{}]/g, " ")
      .replace(/\b(?:grande|maior|pequeno|pequena|menor)\b/g, " ")
      .replace(/\b(?:da|do|de)\b/g, " ")
      .replace(/\bcom\b/g, " ")
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
    const medicineName = !getConversationOpeningIntent(text) && cleaned.length >= 2 ? cleaned : null;
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
      volumeMl: volume ? Number(volume[1].replace(",", ".")) : undefined,
      sizePreference: /\b(?:grande|maior)\b/.test(normalized) ? "larger" : /\b(?:pequeno|pequena|menor)\b/.test(normalized) ? "smaller" : undefined,
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
    const requestedName = this.parseMedicineQuery(query).medicineName || canonical;
    const exactName = this.hasWordOrPhrase(productName, requestedName) ||
      this.hasAllNameWords(productName, requestedName);
    const explicitBrandVariant = exactName && brands.some((brand) =>
      requestedName !== brand && this.hasWordOrPhrase(requestedName, brand),
    );

    if (
      canonical === "paracetamol" &&
      (productName.includes("sinus") || productName.includes(" dc"))
    ) {
      return false;
    }

    if (
      (productName.includes("+") || substanceName.includes(";")) &&
      !(exactName && !this.hasWordOrPhrase(substanceName, canonical)) &&
      !explicitBrandVariant &&
      !["dorflex", "torsilax", "cimegripe", "benegrip", "engov", "neosaldina"].includes(canonical) &&
      !/\bcomposto\b/.test(requestedName)
    ) {
      return false;
    }

    // Brand extensions are different formulations, not automatic substitutes.
    for (const variant of ["composto", "sinus", "eze"]) {
      if (this.hasWordOrPhrase(productName, variant) && !this.hasWordOrPhrase(requestedName, variant)) return false;
    }
    if (canonical === "cimegripe" && /\bzinco\b|\bc\s*\+/.test(productName) && !/\bzinco\b|\bc\s*\+/.test(requestedName)) return false;

    if (exactName) return true;

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
      /\b(sol inj|inj|injetavel|ampolas?|amp|iv|im)\b/.test(text);
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
    if (/\b(?:colirios?|oftalmic[ao])\b/.test(text) && !/\b(?:pomada|creme|gel)\b/.test(text)) return "oftalmico";
    if (/\binjetave(?:l|is)\b/.test(text)) return "injetavel";
    if (/\bcomprim|\bcp\b|\bcom\b(?!\s+\d)/.test(text)) return "comprimido";
    if (/\bcaps|\bcap\b/.test(text)) return "capsula";
    if (
      /\bsolucao nasal\b|\bsol nasal\b|\bsol nas\b|\bsoro fisiologico nasal\b|\bnasal\b/.test(
        text,
      )
    ) {
      return "solucao nasal";
    }
    if (/\bgotas?\b|\bfr got\b/.test(text)) return "gotas";
    if (/\bsuspensao\b|\bsusp\b|\bsus or\b/.test(text)) return "suspensao oral";
    if (/\bsolucao oral\b|\bsol oral\b|\bsol or\b|\boral\b/.test(text)) {
      return "solucao oral";
    }
    if (/\bsuspensao oral\b|\bsusp oral\b/.test(text)) return "suspensao oral";
    if (/\bxarope\b/.test(text)) return "xarope";
    if (/\bpomada\b/.test(text)) return "pomada";
    if (/\bcreme\b/.test(text)) return "creme";
    if (/\bgel\b/.test(text)) return "gel";
    if (/\bspray\b/.test(text)) return "spray";
    if (/\bpastilhas?\b/.test(text)) return "pastilha";
    if (/\bdrageas?\b|\bdrg\b/.test(text)) return "dragea";

    return "outro";
  }

  selectCommercialOptions<T extends SelectorOption>(
    medicineName: string,
    options: T[],
    priorityRules: MedicinePriorityRuleConfig[] = [],
  ) {
    return this.rankCommercialOptions(medicineName, options, priorityRules).selected;
  }

  rankCommercialOptions<T extends SelectorOption>(
    medicineName: string,
    options: T[],
    priorityRules: MedicinePriorityRuleConfig[] = [],
  ) {
    const deduped = new Map<string, T>();

    for (const option of options) {
      if (option.packageInfo?.isInjectable || option.packageInfo?.isHospitalUse) continue;
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

    const parsedQuery = this.parseMedicineQuery(medicineName);
    const scored = [...deduped.values()]
      .map((option) => this.scoreRankedOption(medicineName, option, priorityRules))
      .sort((a, b) => b.score - a.score);
    if (parsedQuery.sizePreference) {
      const measure = scored.some(item => item.option.packageInfo?.volumeMl) ? "volumeMl" : "unitCount";
      scored.sort((a, b) => {
        const left = a.option.packageInfo?.[measure], right = b.option.packageInfo?.[measure];
        if (!left || !right) return Number(Boolean(right)) - Number(Boolean(left)) || b.score - a.score;
        return (parsedQuery.sizePreference === "larger" ? right - left : left - right) || b.score - a.score;
      });
    }
    const ranked = scored.map((item) => item.option);

    if (!ranked.length) {
      return { selected: [] as T[], scored: [] };
    }

    const requestedScored = this.filterByRequestedAttributes(scored, parsedQuery);
    const selectedScored =
      parsedQuery.dosage !== undefined ||
      parsedQuery.formGroup ||
      parsedQuery.packageQuantity !== undefined || parsedQuery.volumeMl !== undefined
        ? this.selectRequestedQueryOptions(
            requestedScored,
            parsedQuery,
            priorityRules,
          )
        : this.selectBalancedOptions(scored, parsedQuery.sizePreference ? [] : priorityRules);

    return {
      selected: selectedScored.map(
        (item, index) =>
          ({
            ...item.option,
            selectionReason: `${item.category}: ${item.reason}`,
            optionId: index + 1,
          }) as T,
      ),
      scored: scored.map((item) => ({
        productName: item.option.productName,
        label: item.option.label,
        formGroup: item.option.formGroup,
        strength: item.option.strength,
        quantity: item.option.packageInfo?.unitCount,
        price: item.option.pricePf,
        score: item.score,
        category: item.category,
        reason: item.reason,
      })),
    };
  }

  private filterByRequestedAttributes<T extends SelectorOption>(
    scored: Array<RankedOption<T>>,
    parsedQuery: ParsedMedicineQuery,
  ) {
    let filtered = scored;

    if (parsedQuery.dosage !== undefined) {
      const dosageMatches = filtered.filter((item) =>
        medicineStrengthMatches(item.option.strength || "", parsedQuery.dosage!),
      );

      // An explicit dose is a constraint, not a preference for another strength.
      filtered = dosageMatches;
    }

    if (parsedQuery.formGroup) {
      const formMatches = filtered.filter(
        (item) => item.option.formGroup === parsedQuery.formGroup,
      );

      filtered = formMatches;
    }

    if (parsedQuery.packageQuantity !== undefined) {
      const quantityMatches = filtered.filter(
        (item) =>
          item.option.packageInfo?.unitCount === parsedQuery.packageQuantity,
      );

      filtered = quantityMatches;
    }

    if (parsedQuery.volumeMl !== undefined) {
      filtered = filtered.filter((item) => item.option.packageInfo?.volumeMl === parsedQuery.volumeMl);
    }

    return filtered;
  }

  private selectBalancedOptions<T extends SelectorOption>(
    scored: Array<RankedOption<T>>,
    priorityRules: MedicinePriorityRuleConfig[],
  ) {
    const hasConfiguredRules = priorityRules.length > 0;
    const selected: Array<RankedOption<T>> = [];
    const pick = (item: RankedOption<T> | undefined, category: string, reason: string) => {
      if (!item || this.isAlreadyPicked(selected, item)) {
        return;
      }

      selected.push({ ...item, category, reason });
    };

    const configuredPrimary = scored.find((item) => item.configPriority > 0);
    pick(
      hasConfiguredRules ? configuredPrimary || scored[0] : scored[0],
      hasConfiguredRules ? "prioridade_comercial" : "melhor_relevancia",
      hasConfiguredRules
        ? "apresentação priorizada na configuração comercial"
        : "maior aderência ao produto pesquisado",
    );

    const dosageCandidates = this.dosageSelectionPool(scored, priorityRules);
    // Bound iteration even if a provider repeats a presentation identifier.
    for (const candidate of dosageCandidates) {
      if (selected.length >= 3) break;
      const selectedDosages = new Set(
        selected
          .map((item) => this.extractDosageSignature(item.option))
          .filter(Boolean),
      );

      const dosage = this.extractDosageSignature(candidate.option);
      if (!dosage || selectedDosages.has(dosage)) continue;

      pick(
        candidate,
        "dosagem_alternativa",
        "dosagem diferente entre as opções comerciais disponíveis",
      );
    }

    pick(
      this.findDifferentForm(scored, selected),
      "forma_alternativa",
      "forma farmacêutica diferente entre as opções comerciais disponíveis",
    );

    if (hasConfiguredRules) {
      for (const item of scored.filter((candidate) => candidate.configPriority > 0)) {
        if (selected.length >= 3) break;
        pick(
          item,
          "prioridade_comercial",
          "apresentacao priorizada na configuracao comercial",
        );
      }
    }

    pick(
      this.findCheapest(scored, selected),
      "menor_preco",
      "menor preço total entre as opções comerciais",
    );

    pick(
      this.findBestUnitPrice(scored, selected) || this.findDistinct(scored, selected),
      "melhor_custo_ou_variacao",
      "melhor custo por unidade ou apresentação diferente",
    );

    for (const item of scored) {
      if (selected.length >= 3) break;
      pick(item, "variacao_relevante", "outra apresentação comercial relevante");
    }

    return selected.slice(0, 3);
  }

  private selectRequestedQueryOptions<T extends SelectorOption>(
    scored: Array<RankedOption<T>>,
    parsedQuery: ParsedMedicineQuery,
    priorityRules: MedicinePriorityRuleConfig[],
  ) {
    const selected: Array<RankedOption<T>> = [];
    const pick = (item: RankedOption<T> | undefined, category: string, reason: string) => {
      if (!item || this.isAlreadyPicked(selected, item)) {
        return;
      }

      selected.push({ ...item, category, reason });
    };

    if (parsedQuery.dosage !== undefined) {
      pick(
        scored.find((item) =>
          medicineStrengthMatches(item.option.strength || "", parsedQuery.dosage!),
        ),
        "dosagem_solicitada",
        "dosagem pedida pelo cliente",
      );
    }

    if (parsedQuery.formGroup) {
      pick(
        scored.find((item) => item.option.formGroup === parsedQuery.formGroup),
        "forma_solicitada",
        "forma farmacêutica pedida pelo cliente",
      );
    }

    if (parsedQuery.packageQuantity !== undefined) {
      pick(
        scored.find(
          (item) =>
            item.option.packageInfo?.unitCount === parsedQuery.packageQuantity,
        ),
        "quantidade_solicitada",
        "quantidade de embalagem pedida pelo cliente",
      );
    }

    const dosageCandidates = this.dosageSelectionPool(scored, priorityRules);
    for (const item of this.sortByDistinctDosage(dosageCandidates, selected)) {
      if (selected.length >= 3) break;
      pick(item, "variacao_relevante", "outra dosagem ou apresentação relevante");
    }

    for (const item of scored) {
      if (selected.length >= 3) break;
      pick(item, "variacao_relevante", "outra apresentação comercial relevante");
    }

    return selected.slice(0, 3);
  }

  private dosageSelectionPool<T extends SelectorOption>(
    scored: Array<RankedOption<T>>,
    priorityRules: MedicinePriorityRuleConfig[],
  ) {
    if (!priorityRules.length) {
      return scored.filter((item) => this.extractDosageSignature(item.option));
    }

    const configuredDosages = new Set(
      priorityRules
        .map((rule) => this.priorityRuleDosageSignature(rule))
        .filter((dosage): dosage is string => Boolean(dosage)),
    );

    if (!configuredDosages.size) {
      return [];
    }

    return scored.filter((item) =>
      configuredDosages.has(this.extractDosageSignature(item.option)),
    );
  }

  private priorityRuleDosageSignature(rule: MedicinePriorityRuleConfig) {
    if (rule.dosageMg !== undefined) {
      return `${rule.dosageMg}mg`;
    }

    if (!rule.dosageText) {
      return "";
    }

    return medicineStrengthSignature(rule.dosageText);
  }

  private sortByDistinctDosage<T extends SelectorOption>(
    scored: Array<RankedOption<T>>,
    selected: Array<RankedOption<T>>,
  ) {
    const selectedDosages = new Set(
      selected.map((item) => this.extractDosageSignature(item.option)),
    );

    return [...scored].sort((a, b) => {
      const aDosage = this.extractDosageSignature(a.option);
      const bDosage = this.extractDosageSignature(b.option);
      const aIsNewDosage = aDosage && !selectedDosages.has(aDosage);
      const bIsNewDosage = bDosage && !selectedDosages.has(bDosage);

      if (aIsNewDosage !== bIsNewDosage) {
        return aIsNewDosage ? -1 : 1;
      }

      return b.score - a.score;
    });
  }

  private scoreRankedOption<T extends SelectorOption>(
    medicineName: string,
    option: T,
    priorityRules: MedicinePriorityRuleConfig[],
  ): RankedOption<T> {
    const genericScore = this.genericRankingScore(medicineName, option);
    const curationScore = this.retailCurationScore(medicineName, option);
    const config = this.priorityRuleScore(option, priorityRules);
    const score =
      this.optionScore(medicineName, option) +
      genericScore +
      curationScore.score +
      config.score;
    const category = config.score > 0 ? "prioridade_configurada" : "ranking_generico";
    const reason =
      config.reason ||
      curationScore.reason ||
      "pontuacao por relevancia, preco e embalagem";

    return {
      option,
      score,
      category,
      reason,
      configPriority: config.score,
      unitPrice: this.unitPrice(option),
      totalPrice: option.pricePf,
      signature: this.presentationSignature(option),
    };
  }

  private priorityRuleScore(
    option: SelectorOption,
    priorityRules: MedicinePriorityRuleConfig[],
  ) {
    const matches = priorityRules
      .filter((rule) => this.optionMatchesPriorityRule(option, rule))
      .sort((a, b) => b.priority - a.priority);

    if (!matches.length) {
      return { score: 0, reason: "" };
    }

    const best = matches[0];
    const details = [
      best.brand ? `marca ${best.brand}` : undefined,
      best.dosageMg ? `${best.dosageMg}mg` : best.dosageText,
      best.formGroup,
      best.quantity ? `${best.quantity} unidades` : undefined,
    ].filter(Boolean);

    return {
      score: best.priority * 10,
      reason: `prioridade ${best.priority}${details.length ? ` (${details.join(", ")})` : ""}`,
    };
  }

  private optionMatchesPriorityRule(
    option: SelectorOption,
    rule: MedicinePriorityRuleConfig,
  ) {
    if (rule.brand && !this.optionHasBrand(option, rule.brand)) {
      return false;
    }

    if (
      rule.dosageMg !== undefined &&
      !this.optionMatchesDosageMg(option, rule.dosageMg)
    ) {
      return false;
    }

    if (
      rule.dosageText &&
      !this.normalize([option.strength, option.label].filter(Boolean).join(" ")).includes(
        this.normalize(rule.dosageText),
      )
    ) {
      return false;
    }

    if (rule.quantity !== undefined && option.packageInfo?.unitCount !== rule.quantity) {
      return false;
    }

    if (
      rule.formGroup &&
      this.normalize(option.formGroup) !== this.normalize(rule.formGroup)
    ) {
      return false;
    }

    return true;
  }

  private retailCurationScore(medicineName: string, option: SelectorOption) {
    const canonical = this.getCanonicalMedicineName(medicineName);
    const text = this.normalize(
      [
        option.productName,
        option.label,
        option.medicineName,
        option.strength,
        option.packageInfo?.formGroup,
      ]
        .filter(Boolean)
        .join(" "),
    );
    let score = 0;
    const reasons: string[] = [];

    if (
      option.source === "popular_manual" ||
      this.normalize(option.selectionReason || "").includes("popular_manual")
    ) {
      score += 6000;
      reasons.push("catalogo popular curado");
    }

    if (/\b(sol inj|inj|injetavel|ampola|amp|hospitalar|iv|im)\b/.test(text)) {
      score -= 8000;
      reasons.push("apresentacao hospitalar ou injetavel evitada no varejo");
    }

    if (option.packageInfo?.unitCount && option.packageInfo.unitCount > 60) {
      score -= 2500;
      reasons.push("embalagem grande demais para venda comum");
    }

    if (canonical === "dipirona") {
      if (this.optionHasBrand(option, "novalgina") && this.optionMatchesDosageMg(option, 500)) {
        score += 900;
        reasons.push("Novalgina 500mg priorizada para varejo");
      }

      if (this.isGenericOption(option, canonical) && this.optionMatchesDosageMg(option, 500)) {
        score += 700;
        reasons.push("dipirona generica 500mg priorizada");
      }

      if (["gotas", "solucao oral"].includes(option.formGroup)) {
        score += 500;
        reasons.push("gotas ou solucao oral mantida como variacao popular");
      }

      if (this.optionHasBrand(option, "lqfex")) {
        score -= 1800;
        reasons.push("marca menos comum ficou abaixo das opcoes populares");
      }
    }

    if (canonical === "dorflex") {
      if (this.optionHasBrand(option, "dorflex") && option.formGroup === "comprimido") {
        score += 850;
        reasons.push("Dorflex comprimido priorizado");
      }

      if (
        this.optionHasBrand(option, "dorflex") &&
        ["gotas", "solucao oral"].includes(option.formGroup)
      ) {
        score += 500;
        reasons.push("Dorflex gotas mantido como variacao popular");
      }
    }

    if (canonical === "neosoro" && option.formGroup === "solucao nasal") {
      score += 800;
      reasons.push("solucao nasal priorizada para Neosoro");
    }

    return {
      score,
      reason: reasons.join("; "),
    };
  }

  private genericRankingScore(medicineName: string, option: SelectorOption) {
    const canonical = this.getCanonicalMedicineName(medicineName);
    let score = 0;

    if (this.normalize(option.productName) === canonical) score += 280;
    if (this.optionHasCommercialBrand(option, canonical)) score += 160;
    if (this.isGenericOption(option, canonical)) score += 120;

    const packageInfo = option.packageInfo;
    const unitCount = packageInfo?.unitCount;

    if (unitCount !== undefined) {
      if (unitCount >= 8 && unitCount <= 30) score += 120;
      if ([10, 12, 15, 20, 28, 30].includes(unitCount)) score += 55;
      if (unitCount > 60) score -= 320;
      if (unitCount >= 50 && unitCount <= 60) score -= 120;
    }

    if (packageInfo?.isInjectable || packageInfo?.isHospitalUse) score -= 1000;
    if (packageInfo?.isLargePackage && (unitCount === undefined || unitCount > 60)) {
      score -= 220;
    }

    const price = option.pricePf;
    if (price !== undefined && price > 0) {
      score += Math.max(0, 140 - price);
      const unitPrice = this.unitPrice(option);
      if (unitPrice !== undefined) {
        score += Math.max(0, 80 - unitPrice * 10);
      }
    }

    return score;
  }

  private findCheapest<T extends SelectorOption>(
    scored: Array<RankedOption<T>>,
    selected: Array<RankedOption<T>>,
  ) {
    return this.selectableCandidates(scored, selected)
      .filter((item) => item.totalPrice !== undefined)
      .sort((a, b) => (a.totalPrice ?? Infinity) - (b.totalPrice ?? Infinity))[0];
  }

  private findBestUnitPrice<T extends SelectorOption>(
    scored: Array<RankedOption<T>>,
    selected: Array<RankedOption<T>>,
  ) {
    return this.selectableCandidates(scored, selected)
      .filter((item) => item.unitPrice !== undefined)
      .sort((a, b) => (a.unitPrice ?? Infinity) - (b.unitPrice ?? Infinity))[0];
  }

  private findDistinct<T extends SelectorOption>(
    scored: Array<RankedOption<T>>,
    selected: Array<RankedOption<T>>,
  ) {
    return this.selectableCandidates(scored, selected)[0];
  }

  private findDifferentForm<T extends SelectorOption>(
    scored: Array<RankedOption<T>>,
    selected: Array<RankedOption<T>>,
  ) {
    const selectedForms = new Set(
      selected.map((item) => item.option.formGroup).filter(Boolean),
    );

    return this.selectableCandidates(scored, selected).find(
      (item) =>
        item.option.formGroup && !selectedForms.has(item.option.formGroup),
    );
  }

  private selectableCandidates<T extends SelectorOption>(
    scored: Array<RankedOption<T>>,
    selected: Array<RankedOption<T>>,
  ) {
    const candidates = scored.filter((item) => !this.isAlreadyPicked(selected, item));
    const nonNegative = candidates.filter((item) => item.score >= 0);

    return nonNegative.length > 0 ? nonNegative : candidates;
  }

  private isAlreadyPicked<T extends SelectorOption>(
    selected: Array<RankedOption<T>>,
    item: RankedOption<T>,
  ) {
    if (Number.isFinite(item.option.presentationId) && selected.some((picked) =>
      picked.option.presentationId === item.option.presentationId &&
      picked.option.source === item.option.source,
    )) {
      return true;
    }

    const sameSignature = selected.filter(
      (picked) => picked.signature === item.signature,
    );

    if (!sameSignature.length) {
      return false;
    }

    // Unknown attributes cannot establish that two distinct products are equal.
    return Boolean(item.option.strength && item.option.formGroup !== "outro" &&
      (item.option.packageInfo?.unitCount || item.option.packageInfo?.volumeMl)) ||
      sameSignature.some((picked) => this.normalize(picked.option.productName) === this.normalize(item.option.productName));
  }

  private unitPrice(option: SelectorOption) {
    const price = option.pricePf;
    const unitCount = option.packageInfo?.unitCount;

    if (!price || !unitCount || unitCount <= 0) {
      return undefined;
    }

    return price / unitCount;
  }

  private presentationSignature(option: SelectorOption) {
    return this.normalize(
      [
        option.formGroup,
        this.extractDosageSignature(option),
        option.packageInfo?.unitCount,
        option.packageInfo?.volumeMl,
      ]
        .filter(Boolean)
        .join("|"),
    );
  }

  private extractDosageSignature(option: SelectorOption) {
    return medicineStrengthSignature(option.strength || "");
  }

  private legacySelectCommercialOptions<T extends SelectorOption>(
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
    return medicineStrengthMatches(option.strength || "", `${requestedMg}mg`);
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
    return this.normalize(option.productName).includes(this.normalize(brand));
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

  private hasAllNameWords(productName: string, requestedName: string) {
    // Catalog titles can insert a manufacturer or reorder words. Require every
    // complete name token in the title, never combine unrelated metadata fields.
    const words = [...new Set(this.normalize(requestedName).match(/[a-z0-9]+/g) || [])];
    return words.length > 1 && words.every((word) => this.hasWordOrPhrase(productName, word));
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
    const strengths = extractMedicineStrengths(normalizedText);
    if (strengths.length) {
      return {
        raw: strengths[0].raw,
        normalized: strengths.map((strength) => strength.label).join(" + "),
        mg: strengths.length === 1 ? strengths[0].mg : undefined,
      };
    }

    const inferredMg = normalizedText.match(/\b(?:de|com)\s*(\d{1,4})\b/);

    if (inferredMg && !this.extractPackageQuantity(normalizedText)) {
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
    ) || normalizedText.match(/\b(\d{1,3})\s*(?:comprimidos?|capsulas?|drageas?|cp|unidades?)\b/);

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
      .toLowerCase()
      .replace(/\belexir\b/g, "elixir")
      .replace(/\s+/g, " ")
      .trim();
  }
}

