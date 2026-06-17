import { Injectable } from "@nestjs/common";
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
    const options = this.catalog[canonical] || [];

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
        "Para dor de cabeca, opcoes comuns sao:",
        "",
        "1. Dipirona",
        "2. Paracetamol",
        "3. Ibuprofeno",
        "4. Dorflex, se for dor por tensao/muscular",
        "",
        "Qual opcao voce deseja?",
      ].join("\n");
    }

    if (/\bnariz entupido\b|\bcongestao nasal\b/.test(normalized)) {
      return [
        "Para nariz entupido, opcoes comuns sao:",
        "",
        "1. Neosoro adulto",
        "2. Neosoro infantil",
        "3. Soro fisiologico nasal",
        "",
        "Qual opcao voce deseja?",
      ].join("\n");
    }

    if (/\bgripe\b|\bresfriado\b/.test(normalized)) {
      return [
        "Para gripe ou resfriado, opcoes comuns sao:",
        "",
        "1. Benegrip",
        "2. Cimegripe",
        "3. Paracetamol",
        "4. Dipirona",
        "",
        "Qual opcao voce deseja?",
      ].join("\n");
    }

    if (/\balergia\b/.test(normalized)) {
      return "Para alergia, uma opcao comum e Loratadina. Deseja consultar?";
    }

    if (/\bazia\b/.test(normalized)) {
      return "Para azia, uma opcao comum e Omeprazol. Deseja consultar?";
    }

    if (/\bgases\b/.test(normalized)) {
      return "Para gases, uma opcao comum e Luftal. Deseja consultar?";
    }

    if (/\bdor muscular\b/.test(normalized)) {
      return "Para dor muscular, opcoes comuns sao Dorflex e Torsilax. Qual deseja consultar?";
    }

    if (/\btosse\b/.test(normalized)) {
      return "Para tosse, preciso saber se e seca ou com catarro para consultar uma opcao comum.";
    }

    if (/\bdor de garganta\b/.test(normalized)) {
      return "Para dor de garganta, posso consultar opcoes comuns de pastilhas ou analgesicos. Qual produto voce prefere?";
    }

    return null;
  }

  private readonly catalog: Record<string, NormalizedMedicineOption[]> = {
    dorflex: [
      this.option("Dorflex comprimido", "Dorflex Comprimido", "comprimido", "dorflex"),
      this.option("Dorflex gotas", "Dorflex Gotas", "gotas", "dorflex"),
    ],
    neosoro: [
      this.option("Neosoro adulto", "Neosoro adulto", "solucao nasal", "neosoro"),
      this.option(
        "Neosoro infantil",
        "Neosoro infantil",
        "solucao nasal",
        "neosoro",
      ),
      this.option(
        "Neosoro soro fisiologico nasal",
        "Soro fisiologico nasal",
        "solucao nasal",
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
      this.option("Cimegripe capsula", "Cimegripe Capsula", "capsula", "cimegripe"),
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
    neosaldina: [
      this.option(
        "Neosaldina dragea",
        "Neosaldina Dragea",
        "dragea",
        "neosaldina",
      ),
    ],
  };

  private option(
    productName: string,
    displayName: string,
    form: string,
    substance: string,
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
    };
  }

  private normalize(value: string) {
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }
}
