import { Module } from "@nestjs/common";
import { BulaApiService } from "./bula-api.service";
import { CommercialMedicineSelector } from "./commercial-medicine-selector";
import { MedicineSearchOrchestratorService } from "./medicine-search-orchestrator.service";
import { PharmaDbAuthService } from "./pharmadb-auth.service";
import { PharmaDbService } from "./pharmadb.service";
import { PopularManualMedicineService } from "./popular-manual-medicine.service";
import { ViaCepService } from "./via-cep.service";

@Module({
  providers: [
    BulaApiService,
    CommercialMedicineSelector,
    MedicineSearchOrchestratorService,
    PharmaDbAuthService,
    PharmaDbService,
    PopularManualMedicineService,
    ViaCepService,
  ],
  exports: [
    BulaApiService,
    CommercialMedicineSelector,
    MedicineSearchOrchestratorService,
    PharmaDbAuthService,
    PharmaDbService,
    PopularManualMedicineService,
    ViaCepService,
  ],
})
export class IntegrationsModule {}
