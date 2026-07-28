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
import { Prisma, WebhookEventStatus } from "@prisma/client";
import { createHash } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
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
    private readonly prisma: PrismaService,
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
  async receive(@Body() payload: SigiloPayWebhookEvent) {
    if (!this.sigiloPayService.validateWebhook(payload)) {
      throw new UnauthorizedException("Webhook SigiloPay inválido.");
    }

    if (!this.isCompletedPaymentWebhook(payload)) {
      this.logger.warn("SIGILOPAY WEBHOOK IGNORED: invalid payload");
      return { received: true, ignored: true };
    }

    const event = await this.persistWebhookEvent(payload);

    if (!event || event.status === WebhookEventStatus.DONE) {
      return { received: true, duplicate: true };
    }

    setImmediate(() => {
      this.processWebhook(event.id, payload).catch((error) => {
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

  private async processWebhook(eventId: string, payload: SigiloPayWebhookEvent) {
    await this.prisma.safePrismaCall(
      "sigilopay.webhook_event.update.processing",
      (prisma) =>
        prisma.webhookEvent.update({
          where: { id: eventId },
          data: {
            status: WebhookEventStatus.PROCESSING,
            attempts: { increment: 1 },
            errorMessage: null,
          },
        }),
      undefined,
    );

    let result: Awaited<ReturnType<PaymentsService["handleSigiloPayWebhook"]>>;

    try {
      result = await this.paymentsService.handleSigiloPayWebhook(payload);
    } catch (error) {
      await this.prisma.safePrismaCall(
        "sigilopay.webhook_event.update.failed",
        (prisma) =>
          prisma.webhookEvent.update({
            where: { id: eventId },
            data: {
              status: WebhookEventStatus.FAILED,
              errorMessage:
                error instanceof Error ? error.message : "Erro desconhecido",
            },
          }),
        undefined,
      );
      throw error;
    }

    await this.prisma.safePrismaCall(
      "sigilopay.webhook_event.update.done",
      (prisma) =>
        prisma.webhookEvent.update({
          where: { id: eventId },
          data: {
            status: WebhookEventStatus.DONE,
            processedAt: new Date(),
            errorMessage: null,
          },
        }),
      undefined,
    );

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

  private async persistWebhookEvent(payload: SigiloPayWebhookEvent) {
    const eventId =
      payload.transaction?.id ||
      createHash("sha256").update(JSON.stringify(payload)).digest("hex");

    try {
      return await this.prisma.safePrismaCall(
        "sigilopay.webhook_event.upsert",
        (prisma) =>
          prisma.webhookEvent.upsert({
            where: {
              provider_eventId: {
                provider: "sigilopay",
                eventId,
              },
            },
            update: {},
            create: {
              provider: "sigilopay",
              eventId,
              status: WebhookEventStatus.PENDING,
              payload: JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue,
            },
          }),
      );
    } catch (error) {
      this.logger.error(
        "Falha ao persistir webhook SigiloPay",
        error instanceof Error ? error.stack : String(error),
      );
      return null;
    }
  }
}
