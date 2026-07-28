import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  MessageDirection,
  MessageRole,
  MessageStatus,
  WhatsappOutboxStatus,
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { RequestContext } from "../observability/request-context.service";
import { PrismaService } from "../prisma/prisma.service";
import {
  WhatsappIncomingMessage,
  WhatsappWebhookPayload,
} from "../webhooks/dto/whatsapp-webhook.dto";
import { ConversationEngineService } from "./conversation-engine.service";
import { WhatsappMediaService } from "./whatsapp-media.service";

interface WhatsappSendResult {
  whatsappMessageId?: string;
}

interface WhatsappGraphResponse {
  messages?: Array<{
    id?: string;
  }>;
}

type WhatsappReplyContent = string | string[];

export class WhatsappSendError extends Error {
  constructor(
    message: string,
    readonly code: "CONFIG_MISSING" | "GRAPH_API_ERROR",
    readonly details?: string,
  ) {
    super(message);
    this.name = "WhatsappSendError";
  }
}

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly conversationEngine: ConversationEngineService,
    private readonly whatsappMediaService: WhatsappMediaService,
  ) {}

  enqueueWebhook(payload: WhatsappWebhookPayload) {
    setImmediate(() => {
      this.handleWebhook(payload).catch((error) => {
        this.logger.error("Falha ao processar webhook do WhatsApp", error);
      });
    });
  }

  async handleWebhook(payload: WhatsappWebhookPayload) {
    await this.processPendingOutbox();

    const changes =
      payload.entry?.flatMap((entry) => entry.changes || []) || [];

    for (const change of changes) {
      const contacts = change.value?.contacts || [];
      const messages = change.value?.messages || [];

      for (const message of messages) {
        const contact = contacts.find((item) => item.wa_id === message.from);
        try {
          await RequestContext.run(
            {
              traceId: randomUUID(),
              whatsappMessageId: message.id,
            },
            () => this.handleIncomingMessage(message, contact?.profile?.name, payload),
          );
        } catch (error) {
          this.logWebhookProcessingError(error);
        }
      }
    }
  }

  async handleIncomingMessage(
    message: WhatsappIncomingMessage,
    customerName?: string,
    rawPayload?: WhatsappWebhookPayload,
  ) {
    const text = this.extractText(message);

    if (message.id) {
      let existingMessage: { id: string } | null = null;

      try {
        existingMessage = await this.prisma.safePrismaCall(
          "whatsapp.message.findUnique.idempotency",
          (prisma) =>
            prisma.message.findUnique({
              where: { whatsappId: message.id },
              select: { id: true },
            }),
        );
      } catch (error) {
        if (this.prisma.isPrismaRecoverableError(error)) {
          if (this.prisma.isPrismaPanicError(error)) {
            this.logger.error(
              "PRISMA PANIC DURING WHATSAPP IDEMPOTENCY CHECK",
            );
          }

          this.logger.error("WHATSAPP WEBHOOK ACKED DESPITE PRISMA ERROR");
          return;
        }

        throw error;
      }

      if (existingMessage) {
        this.logger.log(`Mensagem ${message.id} ja processada`);
        return;
      }
    }

    try {
      const customer = await this.prisma.safePrismaCall(
        "whatsapp.customer.upsert",
        (prisma) =>
          prisma.customer.upsert({
            where: { whatsappNumber: message.from },
            update: customerName ? { name: customerName } : {},
            create: {
              whatsappNumber: message.from,
              name: customerName,
            },
          }),
      );

      const conversation = await this.prisma.safePrismaCall(
        "whatsapp.conversation.findFirst",
        (prisma) =>
          prisma.conversation.findFirst({
            where: {
              customerId: customer.id,
              status: "OPEN",
            },
            orderBy: { createdAt: "desc" },
          }),
      );

      const activeConversation =
        conversation ||
        (await this.prisma.safePrismaCall(
          "whatsapp.conversation.create",
          (prisma) =>
            prisma.conversation.create({
              data: {
                customerId: customer.id,
                whatsappChatId: message.from,
              },
            }),
        ));

      if (!text) {
        await this.prisma.safePrismaCall(
          "whatsapp.message.create.inbound_non_text",
          (prisma) =>
            prisma.message.create({
              data: {
                conversationId: activeConversation.id,
                whatsappId: message.id,
                direction: MessageDirection.INBOUND,
                role: MessageRole.CUSTOMER,
                status: MessageStatus.RECEIVED,
                content: this.describeNonTextMessage(message),
                rawPayload: rawPayload
                  ? JSON.parse(JSON.stringify(rawPayload))
                  : undefined,
              },
          }),
        );

        const imageSearchText = await this.extractSearchTextFromImage(message);

        if (imageSearchText) {
          const reply = await this.prisma.safePrismaCall(
            "whatsapp.conversationEngine.resolveReply.image",
            () =>
              this.conversationEngine.resolveReply(
                activeConversation,
                imageSearchText,
              ),
          );
          await this.replyAndRecord(activeConversation.id, message.from, reply);
          return;
        }

        await this.replyAndRecord(
          activeConversation.id,
          message.from,
          "No momento consigo responder apenas mensagens de texto. Pode me enviar sua dúvida por escrito?",
        );
        return;
      }

      await this.prisma.safePrismaCall(
        "whatsapp.message.create.inbound_text",
        (prisma) =>
          prisma.message.create({
            data: {
              conversationId: activeConversation.id,
              whatsappId: message.id,
              direction: MessageDirection.INBOUND,
              role: MessageRole.CUSTOMER,
              status: MessageStatus.RECEIVED,
              content: text,
              rawPayload: rawPayload
                ? JSON.parse(JSON.stringify(rawPayload))
                : undefined,
            },
          }),
      );

      const reply = await this.prisma.safePrismaCall(
        "whatsapp.conversationEngine.resolveReply",
        () => this.conversationEngine.resolveReply(activeConversation, text),
      );

      await this.replyAndRecord(activeConversation.id, message.from, reply);
    } catch (error) {
      if (this.prisma.isPrismaRecoverableError(error)) {
        this.logWebhookProcessingError(error);
        return;
      }

      throw error;
    }
  }

  private async replyAndRecord(
    conversationId: string,
    recipient: string,
    content: WhatsappReplyContent,
  ) {
    const messages = Array.isArray(content) ? content : [content];

    for (const message of messages) {
      await this.sendAndRecordSingleReply(conversationId, recipient, message);
    }
  }

  private async sendAndRecordSingleReply(
    conversationId: string,
    recipient: string,
    content: string,
  ) {
    const outbox = await this.prisma.safePrismaCall(
      "whatsapp.outbox.create",
      (prisma) =>
        prisma.whatsappOutbox.create({
          data: {
            conversationId,
            recipient,
            content,
            status: WhatsappOutboxStatus.PENDING,
          },
        }),
    );

    await this.processOutboxMessage(outbox.id);
  }

  async processPendingOutbox(limit = 10) {
    const now = new Date();
    const messages = await this.prisma.safePrismaCall(
      "whatsapp.outbox.findMany.pending",
      (prisma) =>
        prisma.whatsappOutbox.findMany({
          where: {
            status: { in: [WhatsappOutboxStatus.PENDING, WhatsappOutboxStatus.FAILED] },
            attempts: { lt: 5 },
            OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
          },
          orderBy: { createdAt: "asc" },
          take: limit,
        }),
      [],
    );

    for (const message of messages) {
      await this.processOutboxMessage(message.id);
    }
  }

  private async processOutboxMessage(outboxId: string) {
    const outbox = await this.prisma.safePrismaCall(
      "whatsapp.outbox.findUnique",
      (prisma) => prisma.whatsappOutbox.findUnique({ where: { id: outboxId } }),
      null,
    );

    if (!outbox || outbox.status === WhatsappOutboxStatus.SENT) {
      return;
    }

    await this.prisma.safePrismaCall(
      "whatsapp.outbox.update.sending",
      (prisma) =>
        prisma.whatsappOutbox.update({
          where: { id: outbox.id },
          data: {
            status: WhatsappOutboxStatus.SENDING,
            attempts: { increment: 1 },
          },
        }),
      undefined,
    );

    try {
      const sendResult = await this.sendTextMessage(outbox.recipient, outbox.content);

      await this.prisma.safePrismaCall(
        "whatsapp.outbox.update.sent",
        (prisma) =>
          prisma.whatsappOutbox.update({
            where: { id: outbox.id },
            data: {
              status: WhatsappOutboxStatus.SENT,
              whatsappMessageId: sendResult.whatsappMessageId,
              errorMessage: null,
            },
          }),
        undefined,
      );

      await this.prisma.safePrismaCall(
        "whatsapp.message.create.outbound_sent",
        (prisma) =>
          prisma.message.create({
            data: {
              conversationId: outbox.conversationId,
              whatsappId: sendResult.whatsappMessageId,
              direction: MessageDirection.OUTBOUND,
              role: MessageRole.ASSISTANT,
              status: MessageStatus.SENT,
              content: outbox.content,
            },
          }),
      );
    } catch (error) {
      this.logger.error("Falha ao enviar resposta pelo WhatsApp", error);
      const errorMessage =
        error instanceof Error ? error.message : "Erro desconhecido ao enviar WhatsApp";
      const nextAttemptAt = new Date(Date.now() + this.retryDelayMs(outbox.attempts + 1));

      await this.prisma.safePrismaCall(
        "whatsapp.outbox.update.failed",
        (prisma) =>
          prisma.whatsappOutbox.update({
            where: { id: outbox.id },
            data: {
              status: WhatsappOutboxStatus.FAILED,
              errorMessage,
              nextAttemptAt,
            },
          }),
        undefined,
      );

      await this.prisma.safePrismaCall(
        "whatsapp.message.create.outbound_failed",
        (prisma) =>
          prisma.message.create({
            data: {
              conversationId: outbox.conversationId,
              direction: MessageDirection.OUTBOUND,
              role: MessageRole.ASSISTANT,
              status: MessageStatus.FAILED,
              content: outbox.content,
              rawPayload: {
                outboxId: outbox.id,
                error: errorMessage,
              },
            },
          }),
        undefined,
      );
    }
  }

  async sendTextMessage(to: string, text: string): Promise<WhatsappSendResult> {
    const accessToken = this.configService.get<string>("WHATSAPP_ACCESS_TOKEN");
    const phoneNumberId = this.configService.get<string>(
      "WHATSAPP_PHONE_NUMBER_ID",
    );
    const apiVersion =
      this.configService.get<string>("WHATSAPP_API_VERSION") || "v25.0";

    if (!accessToken || !phoneNumberId) {
      throw new WhatsappSendError(
        "WhatsApp Cloud API não configurada. Defina WHATSAPP_ACCESS_TOKEN e WHATSAPP_PHONE_NUMBER_ID.",
        "CONFIG_MISSING",
      );
    }

    const response = await fetch(
      `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "text",
          text: {
            preview_url: false,
            body: text,
          },
        }),
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new WhatsappSendError(
        `Graph API retornou erro ${response.status}`,
        "GRAPH_API_ERROR",
        errorBody,
      );
    }

    const data = (await response.json()) as WhatsappGraphResponse;
    return {
      whatsappMessageId: data.messages?.[0]?.id,
    };
  }

  private extractText(message: WhatsappIncomingMessage) {
    if (message.type && message.type !== "text") {
      return null;
    }

    return message.text?.body?.trim() || null;
  }

  private async extractSearchTextFromImage(message: WhatsappIncomingMessage) {
    if (message.type !== "image" || !message.image?.id) {
      return null;
    }

    const extracted = await this.whatsappMediaService.extractMedicineFromImage(
      message.image.id,
      message.image.mime_type,
    );

    if (!extracted) {
      return null;
    }

    this.logger.log(`Texto extraído da embalagem: ${extracted}`);
    return extracted;
  }

  private describeNonTextMessage(message: WhatsappIncomingMessage) {
    if (message.type === "image") {
      return "[imagem recebida]";
    }

    if (message.type === "document") {
      return "[documento recebido]";
    }

    return "[mensagem sem texto]";
  }

  private retryDelayMs(attempts: number) {
    return Math.min(15 * 60 * 1000, Math.max(30 * 1000, attempts * 60 * 1000));
  }

  private logWebhookProcessingError(error: unknown) {
    if (this.prisma.isPrismaRecoverableError(error)) {
      this.logger.error("WHATSAPP WEBHOOK ACKED DESPITE PRISMA ERROR");
    }

    this.logger.error("Falha ao processar mensagem do webhook do WhatsApp", error);
  }
}
