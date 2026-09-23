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
import { OpenAiWebMedicineService } from "./openai-web-medicine.service";

@Module({
  imports: [PrismaModule, ObservabilityModule],
  providers: [
    OpenAiWebMedicineService,
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
    OpenAiWebMedicineService,
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
