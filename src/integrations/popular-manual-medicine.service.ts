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
        "Para dor de cabeça, opções comuns são:",
        "",
        "1. Dipirona",
        "2. Paracetamol",
        "3. Ibuprofeno",
        "4. Dorflex, se for dor por tensão muscular",
        "",
        "Qual opção você deseja?",
      ].join("\n");
    }

    if (/\bnariz entupido\b|\bcongestao nasal\b/.test(normalized)) {
      return [
        "Para nariz entupido, opções comuns são:",
        "",
        "1. Neosoro adulto",
        "2. Neosoro infantil",
        "3. Soro fisiológico nasal",
        "",
        "Qual opção você deseja?",
      ].join("\n");
    }

    if (/\bgripe\b|\bresfriado\b/.test(normalized)) {
      return [
        "Para gripe ou resfriado, opções comuns são:",
        "",
        "1. Benegrip",
        "2. Cimegripe",
        "3. Paracetamol",
        "4. Dipirona",
        "",
        "Qual opção você deseja?",
      ].join("\n");
    }

    if (/\balergia\b/.test(normalized)) {
      return "Para alergia, uma opção comum é Loratadina. Deseja consultar?";
    }

    if (/\bazia\b/.test(normalized)) {
      return "Para azia, uma opção comum é Omeprazol. Deseja consultar?";
    }

    if (/\bgases\b/.test(normalized)) {
      return "Para gases, uma opção comum é Luftal. Deseja consultar?";
    }

    if (/\bdor muscular\b/.test(normalized)) {
      return "Para dor muscular, opções comuns são Dorflex e Torsilax. Qual deseja consultar?";
    }

    if (/\btosse\b/.test(normalized)) {
      return "Para tosse, preciso saber se é seca ou com catarro para consultar uma opção comum.";
    }

    if (/\bdor de garganta\b/.test(normalized)) {
      return "Para dor de garganta, posso consultar opções comuns de pastilhas ou analgésicos. Qual produto você prefere?";
    }

    return null;
  }

  private readonly catalog: Record<string, NormalizedMedicineOption[]> = {
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
    neosaldina: [
      this.option(
        "Neosaldina drágea",
        "Neosaldina Drágea",
        "drágea",
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
