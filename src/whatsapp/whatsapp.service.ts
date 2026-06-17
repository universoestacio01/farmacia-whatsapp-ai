import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Conversation,
  ConversationState,
  MessageDirection,
  MessageRole,
  MessageStatus,
  Prisma,
} from "@prisma/client";
import { AiService } from "../ai/ai.service";
import {
  BulaApiService,
  CommercialMedicineOption,
  MedicineQuestion,
} from "../integrations/bula-api.service";
import { ViaCepService } from "../integrations/via-cep.service";
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
    private readonly viaCepService: ViaCepService,
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

    const reply = await this.resolveReply(activeConversation, text);

    await this.replyAndRecord(activeConversation.id, message.from, reply);
  }

  private async resolveReply(conversation: Conversation, text: string) {
    this.logger.log(`Estado atual da conversa: ${conversation.pendingAction}`);

    if (
      conversation.pendingAction === ConversationState.WAITING_PRESENTATION &&
      conversation.candidateOptions
    ) {
      const options = this.getCandidateOptions(conversation.candidateOptions);
      const selectedOption = this.bulaApiService.findOptionByReply(
        text,
        options,
      );

      if (selectedOption) {
        this.logger.log(`Opcao selecionada: ${selectedOption.label}`);
        await this.prisma.conversation.update({
          where: { id: conversation.id },
          data: {
            selectedPresentation: this.toJson(selectedOption),
            pendingAction: ConversationState.WAITING_QUANTITY,
          },
        });

        return this.bulaApiService.formatSelectedOptionReply(selectedOption);
      }

      this.logger.log("Intent detectada: PRESENTATION_SELECTION_INVALID");
      return "Nao consegui identificar a opcao. Responda com o numero da opcao ou diga comprimido, gotas, capsula ou xarope.";
    }

    if (conversation.pendingAction === ConversationState.WAITING_QUANTITY) {
      const quantity = this.extractQuantity(text);

      if (!quantity) {
        return "Quantas unidades voce deseja? Pode responder apenas com o numero.";
      }

      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { pendingAction: ConversationState.WAITING_CEP },
      });

      return "Certo. Qual o CEP para entrega?";
    }

    if (conversation.pendingAction === ConversationState.WAITING_CEP) {
      const address = await this.viaCepService.findAddressByCep(text);

      if (!address) {
        return "Nao consegui localizar esse CEP. Pode conferir e enviar novamente?";
      }

      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          pendingAction: ConversationState.WAITING_ADDRESS_NUMBER,
          candidateOptions: this.toJson({
            address,
            previousOptions: conversation.candidateOptions,
          }),
        },
      });

      return `Encontrei: ${address.logradouro}, ${address.bairro}, ${address.localidade}-${address.uf}.\nQual o numero do endereco?`;
    }

    if (
      conversation.pendingAction === ConversationState.WAITING_ADDRESS_NUMBER
    ) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { pendingAction: ConversationState.WAITING_CONFIRMATION },
      });

      return "Perfeito. Confirma o pedido para entrega nesse endereco? Responda sim ou nao.";
    }

    if (conversation.pendingAction === ConversationState.WAITING_CONFIRMATION) {
      if (this.normalize(text).startsWith("sim")) {
        await this.prisma.conversation.update({
          where: { id: conversation.id },
          data: { pendingAction: ConversationState.WAITING_PIX },
        });

        return "Pedido confirmado. Vou preparar o Pix para pagamento e te aviso por aqui.";
      }

      await this.resetConversationContext(conversation.id);
      return "Sem problema. Pedido nao confirmado. Se quiser, me diga o produto para recomecar.";
    }

    let medicineQuestion = this.bulaApiService.detectMedicineQuestion(text);

    if (
      conversation.pendingAction === ConversationState.WAITING_MEDICINE_NAME &&
      medicineQuestion
    ) {
      medicineQuestion = {
        ...medicineQuestion,
        intent:
          conversation.lastIntent === "PRICE_REQUEST"
            ? "price"
            : medicineQuestion.intent,
      };
    }

    if (this.bulaApiService.isPriceQuestionWithoutMedicine(text)) {
      this.logger.log("Intent detectada: PRICE_REQUEST");
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastIntent: "PRICE_REQUEST",
          pendingAction: ConversationState.WAITING_MEDICINE_NAME,
        },
      });

      return "Qual produto voce deseja consultar?";
    }

    if (medicineQuestion) {
      return this.handleMedicineQuestion(conversation.id, medicineQuestion);
    }

    return this.aiService.generatePharmacyReply(text);
  }

  private async handleMedicineQuestion(
    conversationId: string,
    question: MedicineQuestion,
  ) {
    this.logger.log(`Intent detectada: ${question.intent.toUpperCase()}`);
    const summary = await this.bulaApiService.lookupMedicine(
      question.medicineName,
    );

    if (!summary) {
      return this.aiService.generatePharmacyReply(question.medicineName);
    }

    if (summary.products.length === 0) {
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: {
          lastIntent: question.intent.toUpperCase(),
          pendingAction: ConversationState.WAITING_MEDICINE_NAME,
          lastMedicine: question.medicineName,
        },
      });
      return this.bulaApiService.formatNotFound(question.medicineName);
    }

    const pricedOptions = summary.options.filter(
      (option) => option.pricePf !== undefined,
    );
    const shouldAskQuantity =
      (question.intent === "price" && pricedOptions.length === 1) ||
      (question.intent !== "price" && summary.options.length === 1);

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        lastIntent: question.intent.toUpperCase(),
        pendingAction: shouldAskQuantity
          ? ConversationState.WAITING_QUANTITY
          : ConversationState.WAITING_PRESENTATION,
        lastMedicine: question.medicineName,
        candidateOptions: this.toJson(summary.options),
        selectedPresentation: shouldAskQuantity
          ? this.toJson(pricedOptions[0] || summary.options[0])
          : Prisma.JsonNull,
      },
    });

    if (question.intent === "price") {
      return this.bulaApiService.formatPriceReply(summary);
    }

    return this.bulaApiService.formatPresentationChoiceReply(summary);
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

  private getCandidateOptions(value: unknown): CommercialMedicineOption[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter((option): option is CommercialMedicineOption => {
      return (
        typeof option === "object" &&
        option !== null &&
        "optionId" in option &&
        "label" in option
      );
    });
  }

  private extractQuantity(text: string) {
    const match = text.match(/\d+/);
    const quantity = match ? Number(match[0]) : null;
    return quantity && quantity > 0 ? quantity : null;
  }

  private async resetConversationContext(conversationId: string) {
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        lastIntent: null,
        pendingAction: ConversationState.IDLE,
        lastMedicine: null,
        selectedPresentation: Prisma.JsonNull,
        candidateOptions: Prisma.JsonNull,
      },
    });
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }

  private formatCurrency(value: number) {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
    }).format(value);
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

  private normalize(value: string) {
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }
}
