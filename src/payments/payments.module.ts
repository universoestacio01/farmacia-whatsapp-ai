import { Module } from "@nestjs/common";
import { PIX_PROVIDER } from "./pix/pix-provider.interface";
import { PaymentsService } from "./payments.service";
import { SigiloPayWebhookController } from "./sigilopay-webhook.controller";
import { SigiloPayService } from "./sigilopay.service";

@Module({
  controllers: [SigiloPayWebhookController],
  providers: [
    PaymentsService,
    SigiloPayService,
    {
      provide: PIX_PROVIDER,
      useExisting: SigiloPayService,
    },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
