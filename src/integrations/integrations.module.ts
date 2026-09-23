import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { ObservabilityModule } from "../observability/observability.module";
import { BulaApiService } from "./bula-api.service";
import { CommercialMedicineSelector } from "./commercial-medicine-selector";
import { ManualRetailProductService } from "./manual-retail-product.service";
import { MedicineSearchOrchestratorService } from "./medicine-search-orchestrator.service";
import { MedicinePriorityRulesService } from "./medicine-priority-rules.service";
import { PopularManualMedicineService } from "./popular-manual-medicine.service";
import { ProductSearchOrchestratorService } from "./product-search-orchestrator.service";
import { ViaCepService } from "./via-cep.service";
import { PrecoPopularService } from "./preco-popular.service";
import { PharmaDbAuthService } from "./pharmadb-auth.service";
import { PharmaDbService } from "./pharmadb.service";
import { BulapiCatalogService } from "./bulapi-catalog.service";

@Module({
  imports: [PrismaModule, ObservabilityModule],
  providers: [
    PharmaDbAuthService,
    PharmaDbService,
    BulapiCatalogService,
    PrecoPopularService,
    BulaApiService,
    CommercialMedicineSelector,
    ManualRetailProductService,
    MedicineSearchOrchestratorService,
    MedicinePriorityRulesService,
    PopularManualMedicineService,
    ProductSearchOrchestratorService,
    ViaCepService,
  ],
  exports: [
    PharmaDbService,
    BulapiCatalogService,
    PrecoPopularService,
    BulaApiService,
    CommercialMedicineSelector,
    ManualRetailProductService,
    MedicineSearchOrchestratorService,
    MedicinePriorityRulesService,
    PopularManualMedicineService,
    ProductSearchOrchestratorService,
    ViaCepService,
  ],
})
export class IntegrationsModule {}
