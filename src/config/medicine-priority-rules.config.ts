export interface MedicinePriorityRuleConfig {
  principleActive: string;
  dosageMg?: number;
  dosageText?: string;
  quantity?: number;
  formGroup?: string;
  brand?: string;
  priority: number;
  enabled?: boolean;
}

export const DEFAULT_MEDICINE_PRIORITY_RULES: MedicinePriorityRuleConfig[] = [
  {
    principleActive: "dipirona",
    brand: "Novalgina",
    dosageMg: 500,
    quantity: 10,
    formGroup: "comprimido",
    priority: 1000,
  },
  {
    principleActive: "dipirona",
    brand: "Novalgina",
    dosageMg: 1000,
    quantity: 10,
    formGroup: "comprimido",
    priority: 950,
  },
  {
    principleActive: "dipirona",
    dosageMg: 500,
    quantity: 10,
    formGroup: "comprimido",
    priority: 900,
  },
  {
    principleActive: "dipirona",
    dosageMg: 500,
    formGroup: "gotas",
    priority: 850,
  },
  {
    principleActive: "ibuprofeno",
    dosageMg: 400,
    quantity: 10,
    formGroup: "comprimido",
    priority: 1000,
  },
  {
    principleActive: "ibuprofeno",
    dosageMg: 600,
    quantity: 10,
    formGroup: "comprimido",
    priority: 950,
  },
  {
    principleActive: "ibuprofeno",
    brand: "Alivium",
    formGroup: "gotas",
    priority: 900,
  },
  {
    principleActive: "ibuprofeno",
    brand: "Advil",
    dosageMg: 400,
    formGroup: "capsula",
    priority: 850,
  },
  {
    principleActive: "paracetamol",
    dosageMg: 500,
    quantity: 10,
    formGroup: "comprimido",
    priority: 1000,
  },
  {
    principleActive: "paracetamol",
    dosageMg: 750,
    quantity: 10,
    formGroup: "comprimido",
    priority: 950,
  },
  {
    principleActive: "paracetamol",
    brand: "Tylenol",
    dosageMg: 750,
    formGroup: "comprimido",
    priority: 900,
  },
  {
    principleActive: "tadalafila",
    dosageMg: 20,
    quantity: 4,
    formGroup: "comprimido",
    priority: 1000,
  },
  {
    principleActive: "tadalafila",
    dosageMg: 5,
    quantity: 30,
    formGroup: "comprimido",
    priority: 900,
  },
  {
    principleActive: "sildenafila",
    dosageMg: 50,
    quantity: 4,
    formGroup: "comprimido",
    priority: 1000,
  },
  {
    principleActive: "sildenafila",
    dosageMg: 100,
    quantity: 4,
    formGroup: "comprimido",
    priority: 950,
  },
  {
    principleActive: "fexofenadina",
    brand: "Allegra",
    dosageMg: 120,
    formGroup: "comprimido",
    priority: 1000,
  },
  {
    principleActive: "fexofenadina",
    brand: "Allegra",
    dosageMg: 180,
    formGroup: "comprimido",
    priority: 950,
  },
  {
    principleActive: "ciprofloxacino",
    dosageMg: 500,
    formGroup: "comprimido",
    priority: 1000,
  },
  {
    principleActive: "clonazepam",
    dosageMg: 2,
    quantity: 30,
    formGroup: "comprimido",
    priority: 1000,
  },
  {
    principleActive: "hidroclorotiazida",
    brand: "Diurix",
    dosageMg: 25,
    quantity: 30,
    formGroup: "comprimido",
    priority: 1000,
  },
  {
    principleActive: "buscopan",
    brand: "Buscopan",
    formGroup: "comprimido",
    priority: 1000,
  },
  {
    principleActive: "luftal",
    brand: "Luftal",
    formGroup: "gotas",
    priority: 1000,
  },
  {
    principleActive: "cimegripe",
    brand: "Cimegripe",
    formGroup: "capsula",
    priority: 1000,
  },
  {
    principleActive: "benegrip",
    brand: "Benegrip",
    formGroup: "comprimido",
    priority: 1000,
  },
  {
    principleActive: "loratadina",
    dosageMg: 10,
    formGroup: "comprimido",
    priority: 1000,
  },
  {
    principleActive: "omeprazol",
    dosageMg: 20,
    quantity: 14,
    formGroup: "capsula",
    priority: 1000,
  },
  {
    principleActive: "neopiridin",
    brand: "Neopiridin",
    priority: 1000,
  },
];
