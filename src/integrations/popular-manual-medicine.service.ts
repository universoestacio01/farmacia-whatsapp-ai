import { Injectable } from "@nestjs/common";
import {
  SYMPTOM_MEDICINE_RULES,
  SymptomMedicineRule,
} from "../config/symptom-medicine.config";
import { CommercialMedicineSelector } from "./commercial-medicine-selector";
import {
  MedicineProvider,
  NormalizedMedicineOption,
} from "./medicine-provider.interface";

@Injectable()
export class PopularManualMedicineService implements MedicineProvider {
  readonly name = "popular_manual" as const;

  constructor(private readonly selector: CommercialMedicineSelector) {}

  async search(query: string): Promise<NormalizedMedicineOption[]> {
    const normalized =
      this.selector.normalizeMedicineName(query) ||
      this.selector.getCanonicalMedicineName(query);
    const canonical = this.selector.getCanonicalMedicineName(normalized);
    const options = this.filterByRequestedBrand(
      normalized,
      this.catalog[canonical] || [],
    );

    return options.map((option) => ({
      ...option,
      manualPricingFallback: true,
      raw: { manual: true },
    }));
  }

  findSymptomOptions(message: string) {
    const normalized = this.normalize(message);

    if (/\bdor de cabeca\b|\bcefaleia\b/.test(normalized)) {
      return [
        "Para dor de cabeça, tenho estas opções comuns:",
        "",
        "1. Dipirona",
        "2. Paracetamol",
        "3. Ibuprofeno",
        "4. Dorflex, se for dor por tensão muscular",
        "",
        "Qual delas você quer consultar?",
      ].join("\n");
    }

    if (/\bnariz entupido\b|\bcongestao nasal\b/.test(normalized)) {
      return [
        "Para nariz entupido, tenho estas opções comuns:",
        "",
        "1. Neosoro adulto",
        "2. Neosoro infantil",
        "3. Soro fisiológico nasal",
        "",
        "Qual delas você quer consultar?",
      ].join("\n");
    }

    if (/\bgripe\b|\bresfriado\b/.test(normalized)) {
      return [
        "Para gripe ou resfriado, tenho estas opções comuns:",
        "",
        "1. Benegrip",
        "2. Cimegripe",
        "3. Paracetamol",
        "4. Dipirona",
        "",
        "Qual delas você quer consultar?",
      ].join("\n");
    }

    if (/\balergia\b/.test(normalized)) {
      return "Para alergia, uma opção comum é Loratadina. Quer consultar?";
    }

    if (/\bazia\b/.test(normalized)) {
      return "Para azia, uma opção comum é Omeprazol. Quer consultar?";
    }

    if (/\bgases\b/.test(normalized)) {
      return "Para gases, uma opção comum é Luftal. Quer consultar?";
    }

    if (/\bdor muscular\b/.test(normalized)) {
      return "Para dor muscular, opções comuns são Dorflex e Torsilax. Qual você quer consultar?";
    }

    if (/\btosse\b/.test(normalized)) {
      return "Para tosse, preciso saber se é seca ou com catarro para te indicar uma opção comum.";
    }

    if (/\bdor de garganta\b/.test(normalized)) {
      return "Para dor de garganta, posso consultar opções comuns de pastilhas ou analgésicos. Qual produto você quer ver?";
    }

    return null;
  }

  findSymptomSuggestion(message: string): SymptomMedicineRule | null {
    const normalized = this.normalize(message);
    const suggestion = SYMPTOM_MEDICINE_RULES.find((rule) =>
      rule.patterns.some((pattern) => normalized.includes(this.normalize(pattern))),
    );

    return suggestion || null;
  }

  private readonly catalog: Record<string, NormalizedMedicineOption[]> = {
    dipirona: [
      this.option(
        "Novalgina",
        "Novalgina Comprimido 500mg",
        "comprimido",
        "dipirona",
        14.9,
        "500mg",
        "500 MG COM CT BL X 10",
      ),
      this.option(
        "Dipirona",
        "Dipirona genérica Comprimido 500mg",
        "comprimido",
        "dipirona",
        8.9,
        "500mg",
        "500 MG COM CT BL X 10",
      ),
      this.option(
        "Novalgina",
        "Novalgina Gotas / solução oral",
        "gotas",
        "dipirona",
        13.9,
        "500mg/ml",
        "500 MG/ML SOL OR CT FR GOT X 20 ML",
      ),
    ],
    ibuprofeno: [
      this.option(
        "Ibuprofeno",
        "Ibuprofeno genérico Comprimido 400mg",
        "comprimido",
        "ibuprofeno",
        9.9,
        "400mg",
        "400 MG COM CT BL X 10",
      ),
      this.option(
        "Ibuprofeno",
        "Ibuprofeno genérico Comprimido 600mg",
        "comprimido",
        "ibuprofeno",
        12.9,
        "600mg",
        "600 MG COM CT BL X 10",
      ),
      this.option(
        "Alivium",
        "Alivium Gotas / suspensão oral",
        "gotas",
        "ibuprofeno",
        13.9,
        "50mg/ml",
        "50 MG/ML SUS OR CT FR GOT X 30 ML",
      ),
      this.option(
        "Advil",
        "Advil Cápsula 400mg",
        "capsula",
        "ibuprofeno",
        12.9,
        "400mg",
        "400 MG CAP CT BL X 8",
      ),
    ],
    paracetamol: [
      this.option(
        "Paracetamol",
        "Paracetamol genérico Comprimido 500mg",
        "comprimido",
        "paracetamol",
        7.9,
        "500mg",
        "500 MG COM CT BL X 10",
      ),
      this.option(
        "Tylenol",
        "Tylenol Comprimido 750mg",
        "comprimido",
        "paracetamol",
        14.9,
        "750mg",
        "750 MG COM CT BL X 10",
      ),
      this.option(
        "Paracetamol",
        "Paracetamol Gotas / solução oral",
        "gotas",
        "paracetamol",
        9.9,
        "200mg/ml",
        "200 MG/ML SOL OR CT FR GOT X 15 ML",
      ),
    ],
    dorflex: [
      this.option("Dorflex comprimido", "Dorflex Comprimido", "comprimido", "dorflex"),
      this.option("Dorflex gotas", "Dorflex Gotas", "gotas", "dorflex"),
    ],
    neosoro: [
      this.option("Neosoro adulto", "Neosoro adulto", "solução nasal", "neosoro"),
      this.option(
        "Neosoro infantil",
        "Neosoro infantil",
        "solução nasal",
        "neosoro",
      ),
      this.option(
        "Neosoro soro fisiológico nasal",
        "Soro fisiológico nasal",
        "solução nasal",
        "neosoro",
      ),
    ],
    torsilax: [
      this.option(
        "Torsilax comprimido",
        "Torsilax Comprimido",
        "comprimido",
        "torsilax",
      ),
    ],
    cimegripe: [
      this.option("Cimegripe cápsula", "Cimegripe Cápsula", "cápsula", "cimegripe"),
      this.option("Cimegripe gotas", "Cimegripe Gotas", "gotas", "cimegripe"),
    ],
    benegrip: [
      this.option(
        "Benegrip comprimido",
        "Benegrip Comprimido",
        "comprimido",
        "benegrip",
      ),
    ],
    buscopan: [
      this.option("Buscopan comprimido", "Buscopan Comprimido", "comprimido", "buscopan"),
      this.option("Buscopan gotas", "Buscopan Gotas", "gotas", "buscopan"),
    ],
    engov: [
      this.option("Engov comprimido", "Engov Comprimido", "comprimido", "engov"),
    ],
    luftal: [
      this.option("Luftal gotas", "Luftal Gotas", "gotas", "luftal"),
      this.option("Luftal comprimido", "Luftal Comprimido", "comprimido", "luftal"),
    ],
    loratadina: [
      this.option(
        "Loratadina",
        "Loratadina genérica Comprimido 10mg",
        "comprimido",
        "loratadina",
        12.9,
        "10mg",
        "10 MG COM CT BL X 12",
      ),
      this.option(
        "Loratadina",
        "Loratadina Xarope",
        "xarope",
        "loratadina",
        18.9,
      ),
    ],
    fexofenadina: [
      this.option(
        "Allegra",
        "Allegra Comprimido 120mg",
        "comprimido",
        "fexofenadina",
        34.9,
        "120mg",
        "120 MG COM CT BL X 10",
      ),
      this.option(
        "Allegra",
        "Allegra Comprimido 180mg",
        "comprimido",
        "fexofenadina",
        39.9,
        "180mg",
        "180 MG COM CT BL X 10",
      ),
      this.option(
        "Fexofenadina",
        "Fexofenadina genérica Comprimido 120mg",
        "comprimido",
        "fexofenadina",
        24.9,
        "120mg",
        "120 MG COM CT BL X 10",
      ),
    ],
    omeprazol: [
      this.option(
        "Omeprazol",
        "Omeprazol genérico Cápsula 20mg",
        "cápsula",
        "omeprazol",
        12.9,
        "20mg",
        "20 MG CAP CT BL X 14",
      ),
      this.option(
        "Omeprazol",
        "Omeprazol genérico Cápsula 20mg",
        "cápsula",
        "omeprazol",
        19.9,
        "20mg",
        "20 MG CAP CT BL X 28",
      ),
    ],
    ciprofloxacino: [
      this.option(
        "Ciprofloxacino",
        "Ciprofloxacino genérico Comprimido 500mg",
        "comprimido",
        "ciprofloxacino",
        24.9,
        "500mg",
        "500 MG COM CT BL X 14",
      ),
      this.option(
        "Cloridrato de Ciprofloxacino",
        "Cloridrato de Ciprofloxacino Comprimido 500mg",
        "comprimido",
        "ciprofloxacino",
        29.9,
        "500mg",
        "500 MG COM CT BL X 14",
      ),
    ],
    neopiridin: [
      this.option(
        "Neopiridin",
        "Neopiridin Pastilha",
        "pastilha",
        "neopiridin",
        14.9,
      ),
    ],
    neosaldina: [
      this.option(
        "Neosaldina drágea",
        "Neosaldina Drágea",
        "drágea",
        "neosaldina",
      ),
    ],
    tadalafila: [
      this.option(
        "Tadalafila",
        "Tadalafila genérica Comprimido 20mg",
        "comprimido",
        "tadalafila",
        19.9,
        "20mg",
        "20 MG COM CT BL X 4",
      ),
      this.option(
        "Tadalafila",
        "Tadalafila genérica Comprimido 5mg",
        "comprimido",
        "tadalafila",
        39.9,
        "5mg",
        "5 MG COM CT BL X 30",
      ),
      this.option(
        "Plenance",
        "Plenance Comprimido 10mg",
        "comprimido",
        "tadalafila",
        49.9,
        "10mg",
        "10 MG COM CT BL X 4",
      ),
    ],
    sildenafila: [
      this.option(
        "Sildenafila",
        "Sildenafila genérica Comprimido 50mg",
        "comprimido",
        "sildenafila",
        19.9,
        "50mg",
        "50 MG COM CT BL X 4",
      ),
      this.option(
        "Sildenafila",
        "Sildenafila genérica Comprimido 100mg",
        "comprimido",
        "sildenafila",
        24.9,
        "100mg",
        "100 MG COM CT BL X 4",
      ),
      this.option(
        "Viagra",
        "Viagra Comprimido 50mg",
        "comprimido",
        "sildenafila",
        69.9,
        "50mg",
        "50 MG COM CT BL X 4",
      ),
    ],
    clonazepam: [
      this.option(
        "Clonazepam",
        "Clonazepam genérico Comprimido 2mg",
        "comprimido",
        "clonazepam",
        14.9,
        "2mg",
        "2 MG COM CT BL X 30",
      ),
      this.option(
        "Rivotril",
        "Rivotril Comprimido 2mg",
        "comprimido",
        "clonazepam",
        24.9,
        "2mg",
        "2 MG COM CT BL X 30",
      ),
      this.option(
        "Rivotril",
        "Rivotril Gotas 2,5mg/ml",
        "gotas",
        "clonazepam",
        29.9,
        "2,5mg/ml",
        "2,5 MG/ML SOL OR CT FR GOT X 20 ML",
      ),
    ],
    hidroclorotiazida: [
      this.option(
        "Diurix",
        "Diurix Comprimido 25mg",
        "comprimido",
        "hidroclorotiazida",
        12.9,
        "25mg",
        "25 MG COM CT BL X 30",
      ),
      this.option(
        "Hidroclorotiazida",
        "Hidroclorotiazida genérica Comprimido 25mg",
        "comprimido",
        "hidroclorotiazida",
        9.9,
        "25mg",
        "25 MG COM CT BL X 30",
      ),
    ],
    venvanse: [
      this.option(
        "Venvanse",
        "Venvanse Cápsula 30mg",
        "cápsula",
        "venvanse",
        243.32,
        "30mg",
        "30 MG CAP CT FR X 28",
      ),
      this.option(
        "Venvanse",
        "Venvanse Cápsula 50mg",
        "cápsula",
        "venvanse",
        243.32,
        "50mg",
        "50 MG CAP CT FR X 28",
      ),
      this.option(
        "Venvanse",
        "Venvanse Cápsula 70mg",
        "cápsula",
        "venvanse",
        243.32,
        "70mg",
        "70 MG CAP CT FR X 28",
      ),
    ],
  };

  private option(
    productName: string,
    displayName: string,
    form: string,
    substance: string,
    priceConsumer?: number,
    dosage?: string,
    packageRaw?: string,
  ): NormalizedMedicineOption {
    return {
      source: "popular_manual",
      productName,
      displayName,
      brand: productName.split(" ")[0],
      substance,
      activeIngredient: substance,
      form,
      presentation: displayName,
      dosage,
      priceConsumer,
      packageInfo: packageRaw
        ? {
            raw: packageRaw,
          }
        : undefined,
    };
  }

  private filterByRequestedBrand(
    normalizedQuery: string,
    options: NormalizedMedicineOption[],
  ) {
    const requestedBrand = [
      "novalgina",
      "alivium",
      "advil",
      "tylenol",
      "allegra",
      "cialis",
      "tadala",
      "plenance",
      "viagra",
      "rivotril",
      "diurix",
    ].find((brand) => normalizedQuery.includes(brand));

    if (!requestedBrand) {
      return options;
    }

    const brandedOptions = options.filter((option) =>
      this.normalize([option.productName, option.displayName].join(" ")).includes(
        requestedBrand,
      ),
    );

    return brandedOptions.length > 0 ? brandedOptions : options;
  }

  private normalize(value: string) {
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }
}
