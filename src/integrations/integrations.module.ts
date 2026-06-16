import { Module } from "@nestjs/common";
import { BulaApiService } from "./bula-api.service";
import { ViaCepService } from "./via-cep.service";

@Module({
  providers: [BulaApiService, ViaCepService],
  exports: [BulaApiService, ViaCepService],
})
export class IntegrationsModule {}
