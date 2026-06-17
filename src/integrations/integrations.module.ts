import { Module } from "@nestjs/common";
import { BulaApiService } from "./bula-api.service";
import { CommercialMedicineSelector } from "./commercial-medicine-selector";
import { CosmosService } from "./cosmos.service";
import { ManualRetailProductService } from "./manual-retail-product.service";
import { MedicineSearchOrchestratorService } from "./medicine-search-orchestrator.service";
import { PharmaDbAuthService } from "./pharmadb-auth.service";
import { PharmaDbService } from "./pharmadb.service";
import { PopularManualMedicineService } from "./popular-manual-medicine.service";
import { ProductSearchOrchestratorService } from "./product-search-orchestrator.service";
import { ViaCepService } from "./via-cep.service";

@Module({
  providers: [
    BulaApiService,
    CommercialMedicineSelector,
    CosmosService,
    ManualRetailProductService,
    MedicineSearchOrchestratorService,
    PharmaDbAuthService,
    PharmaDbService,
    PopularManualMedicineService,
    ProductSearchOrchestratorService,
    ViaCepService,
  ],
  exports: [
    BulaApiService,
    CommercialMedicineSelector,
    CosmosService,
    ManualRetailProductService,
    MedicineSearchOrchestratorService,
    PharmaDbAuthService,
    PharmaDbService,
    PopularManualMedicineService,
    ProductSearchOrchestratorService,
    ViaCepService,
  ],
})
export class IntegrationsModule {}
