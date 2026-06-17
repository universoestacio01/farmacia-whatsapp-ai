export interface CommercialMedicineConfig {
  synonyms: string[];
  preferredBrands: string[];
  preferredForms: string[];
  preferredDosages: string[];
  defaultFormOrder: string[];
  preferredSmallPacks: number[];
  maxDefaultPackSize: number;
}

export const COMMERCIAL_MEDICINES: Record<string, CommercialMedicineConfig> = {
  dipirona: {
    synonyms: ["dipirona", "novalgina", "dipirona sodica", "dipirona sodica"],
    preferredBrands: ["NOVALGINA", "DIPIRONA"],
    preferredForms: ["COMPRIMIDO", "GOTAS", "SOLUCAO ORAL"],
    preferredDosages: ["500MG", "1G", "500MG/ML"],
    defaultFormOrder: ["COMPRIMIDO", "GOTAS", "SOLUCAO ORAL"],
    preferredSmallPacks: [10, 20, 30],
    maxDefaultPackSize: 30,
  },
  ibuprofeno: {
    synonyms: ["ibuprofeno", "advil", "alivium", "ibuprofan"],
    preferredBrands: ["IBUPROFENO", "ALIVIUM", "ADVIL"],
    preferredForms: ["COMPRIMIDO", "CAPSULA", "SUSPENSAO ORAL", "GOTAS"],
    preferredDosages: ["400MG", "600MG", "300MG", "100MG/ML", "50MG/ML"],
    defaultFormOrder: ["COMPRIMIDO", "CAPSULA", "SUSPENSAO ORAL", "GOTAS"],
    preferredSmallPacks: [8, 10, 12, 20, 30],
    maxDefaultPackSize: 30,
  },
  paracetamol: {
    synonyms: ["paracetamol", "tylenol"],
    preferredBrands: ["PARACETAMOL", "TYLENOL"],
    preferredForms: ["COMPRIMIDO", "GOTAS", "SOLUCAO ORAL", "SUSPENSAO ORAL"],
    preferredDosages: ["500MG", "750MG", "200MG/ML"],
    defaultFormOrder: ["COMPRIMIDO", "GOTAS", "SOLUCAO ORAL"],
    preferredSmallPacks: [10, 20, 30],
    maxDefaultPackSize: 30,
  },
  loratadina: {
    synonyms: ["loratadina"],
    preferredBrands: ["LORATADINA"],
    preferredForms: ["COMPRIMIDO", "XAROPE", "SOLUCAO ORAL"],
    preferredDosages: ["10MG", "1MG/ML"],
    defaultFormOrder: ["COMPRIMIDO", "XAROPE", "SOLUCAO ORAL"],
    preferredSmallPacks: [10, 12, 20, 30],
    maxDefaultPackSize: 30,
  },
  omeprazol: {
    synonyms: ["omeprazol"],
    preferredBrands: ["OMEPRAZOL"],
    preferredForms: ["CAPSULA", "COMPRIMIDO"],
    preferredDosages: ["20MG", "40MG"],
    defaultFormOrder: ["CAPSULA", "COMPRIMIDO"],
    preferredSmallPacks: [7, 14, 28, 30],
    maxDefaultPackSize: 30,
  },
  nimesulida: {
    synonyms: ["nimesulida"],
    preferredBrands: ["NIMESULIDA"],
    preferredForms: ["COMPRIMIDO", "GOTAS", "SUSPENSAO ORAL"],
    preferredDosages: ["100MG", "50MG/ML"],
    defaultFormOrder: ["COMPRIMIDO", "GOTAS", "SUSPENSAO ORAL"],
    preferredSmallPacks: [10, 12, 20],
    maxDefaultPackSize: 30,
  },
  amoxicilina: {
    synonyms: ["amoxicilina"],
    preferredBrands: ["AMOXICILINA"],
    preferredForms: ["CAPSULA", "COMPRIMIDO", "SUSPENSAO ORAL"],
    preferredDosages: ["500MG", "875MG", "250MG/5ML"],
    defaultFormOrder: ["CAPSULA", "COMPRIMIDO", "SUSPENSAO ORAL"],
    preferredSmallPacks: [8, 12, 14, 21],
    maxDefaultPackSize: 30,
  },
  dorflex: {
    synonyms: ["dorflex"],
    preferredBrands: ["DORFLEX"],
    preferredForms: ["COMPRIMIDO", "GOTAS"],
    preferredDosages: ["300MG", "35MG", "50MG"],
    defaultFormOrder: ["COMPRIMIDO", "GOTAS"],
    preferredSmallPacks: [10, 20, 30],
    maxDefaultPackSize: 30,
  },
  buscopan: {
    synonyms: ["buscopan", "butilbrometo de escopolamina"],
    preferredBrands: ["BUSCOPAN"],
    preferredForms: ["COMPRIMIDO", "GOTAS", "SOLUCAO ORAL"],
    preferredDosages: ["10MG", "20MG/ML"],
    defaultFormOrder: ["COMPRIMIDO", "GOTAS", "SOLUCAO ORAL"],
    preferredSmallPacks: [10, 20, 30],
    maxDefaultPackSize: 30,
  },
  benegrip: {
    synonyms: ["benegrip"],
    preferredBrands: ["BENEGRIP"],
    preferredForms: ["COMPRIMIDO", "CAPSULA", "SOLUCAO ORAL"],
    preferredDosages: ["500MG"],
    defaultFormOrder: ["COMPRIMIDO", "CAPSULA", "SOLUCAO ORAL"],
    preferredSmallPacks: [6, 10, 12, 20],
    maxDefaultPackSize: 30,
  },
};
