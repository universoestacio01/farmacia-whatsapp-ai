import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { WhatsappService } from "../whatsapp/whatsapp.service";
import { PaymentsService } from "./payments.service";
import { SigiloPayWebhookEvent } from "./payment.types";
import { SigiloPayService } from "./sigilopay.service";

@Controller()
export class SigiloPayWebhookController {
  private readonly logger = new Logger(SigiloPayWebhookController.name);

  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly sigiloPayService: SigiloPayService,
    private readonly moduleRef: ModuleRef,
  ) {}

  @Get("webhook/sigilopay")
  health() {
    return {
      status: "ok",
      provider: "sigilopay",
    };
  }

  @Post("webhook/sigilopay")
  @HttpCode(200)
  receive(@Body() payload: SigiloPayWebhookEvent) {
    if (!this.sigiloPayService.validateWebhook(payload)) {
      throw new UnauthorizedException("Webhook SigiloPay inválido.");
    }

    if (!this.isCompletedPaymentWebhook(payload)) {
      this.logger.warn("SIGILOPAY WEBHOOK IGNORED: invalid payload");
      return { received: true, ignored: true };
    }

    setImmediate(() => {
      this.processWebhook(payload).catch((error) => {
        this.logger.error(
          "Falha ao processar webhook SigiloPay",
          error instanceof Error ? error.stack : String(error),
        );
      });
    });

    return { received: true };
  }

  private isCompletedPaymentWebhook(payload: SigiloPayWebhookEvent) {
    return Boolean(
      payload.event === "TRANSACTION_PAID" &&
        payload.transaction?.id &&
        payload.transaction.status === "COMPLETED",
    );
  }

  private async processWebhook(payload: SigiloPayWebhookEvent) {
    const result = await this.paymentsService.handleSigiloPayWebhook(payload);

    if (!result.notified || !result.whatsappNumber || !result.message) {
      return;
    }

    try {
      const whatsapp = this.moduleRef.get(WhatsappService, { strict: false });
      await whatsapp.sendTextMessage(result.whatsappNumber, result.message);
    } catch (error) {
      this.logger.error(
        "Falha ao avisar cliente sobre pagamento aprovado",
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
