export type ProductProviderName = "cosmos" | "manual_catalog";
export type RetailProductPriceSource =
  | "cosmos_avg_price"
  | "cosmos_max_price"
  | "cosmos_price_string"
  | "default_category_price"
  | "premium_brand_price";

export interface ProductProvider {
  name: ProductProviderName;
  search(query: string): Promise<NormalizedRetailProduct[]>;
  findByGtin(gtin: string): Promise<NormalizedRetailProduct | null>;
}

export interface NormalizedRetailProduct {
  source: ProductProviderName;
  sourceId?: string;
  gtin?: string;
  ean?: string;

  productName: string;
  displayName: string;
  description?: string;

  brand?: string;
  manufacturer?: string;
  category?: string;
  gpcDescription?: string;
  ncmCode?: string;
  ncmDescription?: string;

  imageUrl?: string;
  thumbnailUrl?: string;

  avgPrice?: number;
  maxPrice?: number;
  referencePrice?: number;
  salePrice?: number;
  salePriceSource?: RetailProductPriceSource;

  grossWeight?: number;
  netWeight?: number;
  width?: number;
  height?: number;
  length?: number;

  raw?: unknown;
}
