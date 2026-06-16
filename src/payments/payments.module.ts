import { Module } from "@nestjs/common";
import { NoopPixProvider } from "./pix/noop-pix.provider";
import { PIX_PROVIDER } from "./pix/pix-provider.interface";
import { PaymentsService } from "./payments.service";

@Module({
  providers: [
    PaymentsService,
    {
      provide: PIX_PROVIDER,
      useClass: NoopPixProvider,
    },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
