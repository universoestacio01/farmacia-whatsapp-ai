import { Injectable, Logger } from "@nestjs/common";
import { Prisma, WebhookEventStatus } from "@prisma/client";
import { createHash } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { WhatsappWebhookPayload } from "../webhooks/dto/whatsapp-webhook.dto";
import { WhatsappService } from "./whatsapp.service";

@Injectable()
export class WhatsappWebhookQueueService {
  private readonly logger = new Logger(WhatsappWebhookQueueService.name);
  private processing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsappService: WhatsappService,
  ) {}

  async enqueue(payload: WhatsappWebhookPayload) {
    const eventId = this.getEventId(payload);

    try {
      await this.prisma.safePrismaCall(
        "whatsapp.webhook_event.upsert",
        (prisma) =>
          prisma.webhookEvent.upsert({
            where: {
              provider_eventId: {
                provider: "whatsapp",
                eventId,
              },
            },
            update: {},
            create: {
              provider: "whatsapp",
              eventId,
              status: WebhookEventStatus.PENDING,
              payload: this.toJson(payload),
            },
          }),
      );
    } catch (error) {
      this.logger.error(
        "WHATSAPP WEBHOOK QUEUE PERSISTENCE FAILED, USING IN-MEMORY FALLBACK",
        error instanceof Error ? error.stack : undefined,
      );
      this.whatsappService.enqueueWebhook(payload);
      return { queued: false, fallback: true };
    }

    setImmediate(() => {
      this.processPending().catch((error) => {
        this.logger.error(
          "Falha ao processar fila persistente do WhatsApp",
          error instanceof Error ? error.stack : undefined,
        );
      });
    });

    return { queued: true, fallback: false };
  }

  async processPending(limit = 10) {
    if (this.processing) {
      return;
    }

    this.processing = true;

    try {
      const events = await this.prisma.safePrismaCall(
        "whatsapp.webhook_event.findMany.pending",
        (prisma) =>
          prisma.webhookEvent.findMany({
            where: {
              provider: "whatsapp",
              status: { in: [WebhookEventStatus.PENDING, WebhookEventStatus.FAILED] },
              attempts: { lt: 5 },
            },
            orderBy: { createdAt: "asc" },
            take: limit,
          }),
        [],
      );

      for (const event of events) {
        await this.processEvent(event.id, event.payload as WhatsappWebhookPayload);
      }
    } finally {
      this.processing = false;
    }
  }

  private async processEvent(id: string, payload: WhatsappWebhookPayload) {
    await this.prisma.safePrismaCall(
      "whatsapp.webhook_event.update.processing",
      (prisma) =>
        prisma.webhookEvent.update({
          where: { id },
          data: {
            status: WebhookEventStatus.PROCESSING,
            attempts: { increment: 1 },
            errorMessage: null,
          },
        }),
      undefined,
    );

    try {
      await this.whatsappService.handleWebhook(payload);
      await this.prisma.safePrismaCall(
        "whatsapp.webhook_event.update.done",
        (prisma) =>
          prisma.webhookEvent.update({
            where: { id },
            data: {
              status: WebhookEventStatus.DONE,
              processedAt: new Date(),
              errorMessage: null,
            },
          }),
        undefined,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Erro desconhecido no webhook";
      await this.prisma.safePrismaCall(
        "whatsapp.webhook_event.update.failed",
        (prisma) =>
          prisma.webhookEvent.update({
            where: { id },
            data: {
              status: WebhookEventStatus.FAILED,
              errorMessage: message,
            },
          }),
        undefined,
      );
      throw error;
    }
  }

  private getEventId(payload: WhatsappWebhookPayload) {
    const messageIds = payload.entry
      ?.flatMap((entry) => entry.changes || [])
      .flatMap((change) => change.value?.messages || [])
      .map((message) => message.id)
      .filter(Boolean);

    if (messageIds?.length) {
      return messageIds.join("|");
    }

    return createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex")
      .slice(0, 64);
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
