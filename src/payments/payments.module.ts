import { Module } from "@nestjs/common";
import { PIX_PROVIDER } from "./pix/pix-provider.interface";
import { PaymentsService } from "./payments.service";
import { SigiloPayService } from "./sigilopay.service";
import { StaticPixService } from "./static-pix.service";

@Module({
  providers: [
    PaymentsService,
    SigiloPayService,
    StaticPixService,
    {
      provide: PIX_PROVIDER,
      useExisting: StaticPixService,
    },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
