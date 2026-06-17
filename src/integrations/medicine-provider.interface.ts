export type MedicineProviderName = "pharmadb" | "bulapi" | "popular_manual";

export interface MedicineProvider {
  name: MedicineProviderName;
  search(query: string): Promise<NormalizedMedicineOption[]>;
}

export interface NormalizedMedicineOption {
  source: MedicineProviderName;
  sourceId?: string;

  productName: string;
  displayName: string;

  activeIngredient?: string;
  substance?: string;
  brand?: string;
  manufacturer?: string;
  laboratory?: string;

  presentation?: string;
  form?: string;
  dosage?: string;

  packageInfo?: {
    raw?: string;
    unitCount?: number;
    volumeMl?: number;
    packageType?: string;
    isLargePack?: boolean;
    isHospitalUse?: boolean;
    isInjectable?: boolean;
  };

  regulatoryCategory?: string;
  anvisaRegister?: string;
  ean?: string;
  ggrem?: string;

  priceFactory?: number;
  priceConsumer?: number;
  pmcWithIcms?: number;

  bulaPacienteUrl?: string;
  bulaProfissionalUrl?: string;

  manualPricingFallback?: boolean;
  raw?: unknown;
}
