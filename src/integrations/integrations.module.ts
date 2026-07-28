import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { ObservabilityModule } from "../observability/observability.module";
import { BulaApiService } from "./bula-api.service";
import { CommercialMedicineSelector } from "./commercial-medicine-selector";
import { CosmosService } from "./cosmos.service";
import { CosmosTokenPoolService } from "./cosmos-token-pool.service";
import { ManualRetailProductService } from "./manual-retail-product.service";
import { MedicineSearchOrchestratorService } from "./medicine-search-orchestrator.service";
import { MedicinePriorityRulesService } from "./medicine-priority-rules.service";
import { PharmaDbAuthService } from "./pharmadb-auth.service";
import { PharmaDbService } from "./pharmadb.service";
import { PopularManualMedicineService } from "./popular-manual-medicine.service";
import { ProductSearchOrchestratorService } from "./product-search-orchestrator.service";
import { ViaCepService } from "./via-cep.service";

@Module({
  imports: [PrismaModule, ObservabilityModule],
  providers: [
    BulaApiService,
    CommercialMedicineSelector,
    CosmosTokenPoolService,
    CosmosService,
    ManualRetailProductService,
    MedicineSearchOrchestratorService,
    MedicinePriorityRulesService,
    PharmaDbAuthService,
    PharmaDbService,
    PopularManualMedicineService,
    ProductSearchOrchestratorService,
    ViaCepService,
  ],
  exports: [
    BulaApiService,
    CommercialMedicineSelector,
    CosmosTokenPoolService,
    CosmosService,
    ManualRetailProductService,
    MedicineSearchOrchestratorService,
    MedicinePriorityRulesService,
    PharmaDbAuthService,
    PharmaDbService,
    PopularManualMedicineService,
    ProductSearchOrchestratorService,
    ViaCepService,
  ],
})
export class IntegrationsModule {}
