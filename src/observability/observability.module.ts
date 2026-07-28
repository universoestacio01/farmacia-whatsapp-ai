import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { ProviderRequestLogService } from "./provider-request-log.service";

@Module({
  imports: [PrismaModule],
  providers: [ProviderRequestLogService],
  exports: [ProviderRequestLogService],
})
export class ObservabilityModule {}
