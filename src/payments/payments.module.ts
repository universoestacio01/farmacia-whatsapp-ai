import { Module } from "@nestjs/common";
import { PIX_PROVIDER } from "./pix/pix-provider.interface";
import { DirectPixService } from "./direct-pix.service";
import { PaymentsService } from "./payments.service";
import { SigiloPayService } from "./sigilopay.service";

@Module({
  providers: [
    PaymentsService,
    SigiloPayService,
    DirectPixService,
    {
      provide: PIX_PROVIDER,
      useExisting: DirectPixService,
    },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
