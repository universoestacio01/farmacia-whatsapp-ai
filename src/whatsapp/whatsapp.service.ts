import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MessageDirection, MessageRole, MessageStatus } from "@prisma/client";
import { AiService } from "../ai/ai.service";
import { BulaApiService } from "../integrations/bula-api.service";
import { PrismaService } from "../prisma/prisma.service";
import {
  WhatsappIncomingMessage,
  WhatsappWebhookPayload,
} from "../webhooks/dto/whatsapp-webhook.dto";

interface WhatsappSendResult {
  whatsappMessageId?: string;
}

interface WhatsappGraphResponse {
  messages?: Array<{
    id?: string;
  }>;
}

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
    private readonly aiService: AiService,
    private readonly bulaApiService: BulaApiService,
  ) {}

  enqueueWebhook(payload: WhatsappWebhookPayload) {
    setImmediate(() => {
      this.handleWebhook(payload).catch((error) => {
        this.logger.error("Falha ao processar webhook do WhatsApp", error);
      });
    });
  }

  async handleWebhook(payload: WhatsappWebhookPayload) {
    const changes =
      payload.entry?.flatMap((entry) => entry.changes || []) || [];

    for (const change of changes) {
      const contacts = change.value?.contacts || [];
      const messages = change.value?.messages || [];

      for (const message of messages) {
        const contact = contacts.find((item) => item.wa_id === message.from);
        await this.handleIncomingMessage(
          message,
          contact?.profile?.name,
          payload,
        );
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
      const existingMessage = await this.prisma.message.findUnique({
        where: { whatsappId: message.id },
      });

      if (existingMessage) {
        this.logger.log(`Mensagem ${message.id} ja processada`);
        return;
      }
    }

    const customer = await this.prisma.customer.upsert({
      where: { whatsappNumber: message.from },
      update: customerName ? { name: customerName } : {},
      create: {
        whatsappNumber: message.from,
        name: customerName,
      },
    });

    const conversation = await this.prisma.conversation.findFirst({
      where: {
        customerId: customer.id,
        status: "OPEN",
      },
      orderBy: { createdAt: "desc" },
    });

    const activeConversation =
      conversation ||
      (await this.prisma.conversation.create({
        data: {
          customerId: customer.id,
          whatsappChatId: message.from,
        },
      }));

    if (!text) {
      await this.prisma.message.create({
        data: {
          conversationId: activeConversation.id,
          whatsappId: message.id,
          direction: MessageDirection.INBOUND,
          role: MessageRole.CUSTOMER,
          status: MessageStatus.RECEIVED,
          content: "[mensagem sem texto]",
          rawPayload: rawPayload
            ? JSON.parse(JSON.stringify(rawPayload))
            : undefined,
        },
      });

      await this.replyAndRecord(
        activeConversation.id,
        message.from,
        "No momento consigo responder apenas mensagens de texto. Pode me enviar sua duvida por escrito?",
      );
      return;
    }

    await this.prisma.message.create({
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
    });

    const medicineQuestion = this.bulaApiService.detectMedicineQuestion(text);
    const bulaReply = medicineQuestion
      ? await this.bulaApiService.buildMedicineReply(medicineQuestion)
      : null;
    const reply =
      bulaReply || (await this.aiService.generatePharmacyReply(text));

    await this.replyAndRecord(activeConversation.id, message.from, reply);
  }

  private async replyAndRecord(
    conversationId: string,
    recipient: string,
    content: string,
  ) {
    try {
      const sendResult = await this.sendTextMessage(recipient, content);

      await this.prisma.message.create({
        data: {
          conversationId,
          whatsappId: sendResult.whatsappMessageId,
          direction: MessageDirection.OUTBOUND,
          role: MessageRole.ASSISTANT,
          status: MessageStatus.SENT,
          content,
        },
      });
    } catch (error) {
      this.logger.error("Falha ao enviar resposta pelo WhatsApp", error);

      await this.prisma.message.create({
        data: {
          conversationId,
          direction: MessageDirection.OUTBOUND,
          role: MessageRole.ASSISTANT,
          status: MessageStatus.FAILED,
          content,
          rawPayload: {
            error:
              error instanceof Error
                ? error.message
                : "Erro desconhecido ao enviar WhatsApp",
          },
        },
      });
    }
  }

  async sendTextMessage(to: string, text: string): Promise<WhatsappSendResult> {
    const accessToken = this.configService.get<string>("WHATSAPP_ACCESS_TOKEN");
    const phoneNumberId = this.configService.get<string>(
      "WHATSAPP_PHONE_NUMBER_ID",
    );
    const apiVersion =
      this.configService.get<string>("WHATSAPP_API_VERSION") || "v21.0";

    if (!accessToken || !phoneNumberId) {
      throw new WhatsappSendError(
        "WhatsApp Cloud API nao configurada. Defina WHATSAPP_ACCESS_TOKEN e WHATSAPP_PHONE_NUMBER_ID.",
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
}
