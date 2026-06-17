import { Module } from "@nestjs/common";
import { BulaApiService } from "./bula-api.service";
import { CommercialMedicineSelector } from "./commercial-medicine-selector";
import { ViaCepService } from "./via-cep.service";

@Module({
  providers: [BulaApiService, CommercialMedicineSelector, ViaCepService],
  exports: [BulaApiService, CommercialMedicineSelector, ViaCepService],
})
export class IntegrationsModule {}
