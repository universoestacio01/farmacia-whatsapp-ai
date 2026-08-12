import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ConversationStatus,
  ConversationState,
  MessageDirection,
  MessageRole,
  MessageStatus,
  OrderStatus,
  PaymentStatus,
  Prisma,
} from "@prisma/client";
import { sanitizeEnv } from "../config/env-sanitize";
import { MedicinePriorityRuleConfig } from "../config/medicine-priority-rules.config";
import {
  DEFAULT_PIX_KEY,
  DEFAULT_PIX_MERCHANT_CITY,
  DEFAULT_PIX_MERCHANT_NAME,
} from "../config/direct-pix.config";
import { MedicinePriorityRulesService } from "../integrations/medicine-priority-rules.service";
import { PrismaService } from "../prisma/prisma.service";
import { WhatsappService } from "../whatsapp/whatsapp.service";

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly whatsappService: WhatsappService,
    private readonly medicinePriorityRules: MedicinePriorityRulesService,
  ) {}

  async overview() {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [
      openConversations,
      activeConversations,
      messages24h,
      failedMessages24h,
      ordersToday,
      pendingPayments,
      paidPayments,
      latestConversations,
      latestOrders,
    ] = await Promise.all([
      this.countConversations({ status: "OPEN" }),
      this.countConversations({
        pendingAction: { not: ConversationState.IDLE },
      }),
      this.countMessages({ createdAt: { gte: since } }),
      this.countMessages({
        status: MessageStatus.FAILED,
        createdAt: { gte: since },
      }),
      this.countOrders({ createdAt: { gte: since } }),
      this.countPayments({ status: PaymentStatus.PENDING }),
      this.prisma.safePrismaCall(
        "admin.payment.aggregate.paid",
        (prisma) =>
          prisma.payment.aggregate({
            where: { status: PaymentStatus.PAID },
            _sum: { amountCents: true },
            _count: true,
          }),
        { _sum: { amountCents: 0 }, _count: 0 },
      ),
      this.listConversations(5),
      this.listOrders(5),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      cards: {
        openConversations,
        activeConversations,
        messages24h,
        failedMessages24h,
        ordersToday,
        pendingPayments,
        paidOrders: paidPayments._count,
        paidRevenueCents: paidPayments._sum.amountCents || 0,
      },
      latestConversations,
      latestOrders,
      pendingPaymentsQueue: await this.pendingPaymentOrders(8),
      attention: await this.attentionQueue(8),
      providers: this.providers(),
    };
  }

  async listConversations(
    limit = 20,
    filters: { search?: string; state?: string; status?: string } = {},
  ) {
    const take = this.clampLimit(limit);
    const where = this.buildConversationWhere(filters);
    const conversations = await this.prisma.safePrismaCall(
      "admin.conversation.findMany",
      (prisma) =>
        prisma.conversation.findMany({
          where,
          orderBy: { updatedAt: "desc" },
          take,
          include: {
            customer: true,
            messages: {
              orderBy: { createdAt: "desc" },
              take: 1,
            },
          },
        }),
      [],
    );

    return conversations.map((conversation) => ({
      id: conversation.id,
      customerId: conversation.customerId,
      customerName: conversation.customer.name,
      whatsappNumber: conversation.customer.whatsappNumber,
      status: conversation.status,
      pendingAction: conversation.pendingAction,
      lastIntent: conversation.lastIntent,
      currentMedicineQuery: conversation.currentMedicineQuery,
      currentRetailCategory: conversation.currentRetailCategory,
      cartItems: Array.isArray(conversation.cart) ? conversation.cart.length : 0,
      cart: this.asArray(conversation.cart),
      pendingAddress: this.asObject(conversation.pendingAddress),
      updatedAt: conversation.updatedAt,
      lastMessage: conversation.messages[0]
        ? {
            direction: conversation.messages[0].direction,
            status: conversation.messages[0].status,
            content: this.truncate(conversation.messages[0].content, 180),
            createdAt: conversation.messages[0].createdAt,
          }
        : null,
    }));
  }

  async attentionQueue(limit = 30) {
    const take = this.clampLimit(limit, 100);
    const staleDate = new Date(Date.now() - 20 * 60 * 1000);
    const conversations = await this.prisma.safePrismaCall(
      "admin.conversation.findMany.attention",
      (prisma) =>
        prisma.conversation.findMany({
          where: {
            status: ConversationStatus.OPEN,
            OR: [
              { pendingAction: { not: ConversationState.IDLE } },
              { updatedAt: { lt: staleDate } },
              { messages: { some: { status: MessageStatus.FAILED } } },
            ],
          },
          orderBy: { updatedAt: "asc" },
          take,
          include: {
            customer: true,
            messages: { orderBy: { createdAt: "desc" }, take: 1 },
          },
        }),
      [],
    );

    return conversations.map((conversation) => ({
      id: conversation.id,
      customerName: conversation.customer.name,
      whatsappNumber: conversation.customer.whatsappNumber,
      pendingAction: conversation.pendingAction,
      updatedAt: conversation.updatedAt,
      reason: this.resolveAttentionReason(conversation),
      lastMessage: conversation.messages[0]
        ? this.truncate(conversation.messages[0].content, 160)
        : null,
    }));
  }

  async conversationMessages(conversationId: string, limit = 60) {
    const take = this.clampLimit(limit, 100);
    const messages = await this.prisma.safePrismaCall(
      "admin.message.findMany.by_conversation",
      (prisma) =>
        prisma.message.findMany({
          where: { conversationId },
          orderBy: { createdAt: "asc" },
          take,
        }),
      [],
    );

    return messages.map((message) => ({
      id: message.id,
      direction: message.direction,
      role: message.role,
      status: message.status,
      content: message.content,
      createdAt: message.createdAt,
    }));
  }

  async listOrders(limit = 20) {
    const take = this.clampLimit(limit, 200);
    const orders = await this.prisma.safePrismaCall(
      "admin.order.findMany",
      (prisma) =>
        prisma.order.findMany({
          orderBy: { createdAt: "desc" },
          take,
          include: {
            customer: true,
            items: true,
            payments: {
              orderBy: { createdAt: "desc" },
              take: 1,
            },
          },
        }),
      [],
    );

    return orders.map((order) => ({
      id: order.id,
      conversationId: order.conversationId,
      status: order.status,
      totalCents: order.totalCents,
      notes: this.parseOrderNotes(order.notes),
      items: order.items.map((item) => ({
        id: item.id,
        type: item.type,
        name: item.name,
        brand: item.brand,
        presentation: item.presentation,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        totalCents: item.totalCents,
        source: item.source,
      })),
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      customer: {
        id: order.customerId,
        name: order.customer.name,
        whatsappNumber: order.customer.whatsappNumber,
      },
      payment: order.payments[0]
        ? {
            id: order.payments[0].id,
            provider: order.payments[0].provider,
            status: order.payments[0].status,
            amountCents: order.payments[0].amountCents,
            providerTransactionId: order.payments[0].providerTransactionId,
            createdAt: order.payments[0].createdAt,
            paidAt: order.payments[0].paidAt,
          }
        : null,
    }));
  }

  async pendingPaymentOrders(limit = 50) {
    const take = this.clampLimit(limit, 200);
    const orders = await this.prisma.safePrismaCall(
      "admin.order.findMany.pending_payments",
      (prisma) =>
        prisma.order.findMany({
          where: {
            status: {
              in: [OrderStatus.CONFIRMED, OrderStatus.PENDING_PAYMENT_MANUAL],
            },
            payments: { some: { status: PaymentStatus.PENDING } },
          },
          orderBy: { createdAt: "asc" },
          take,
          include: {
            customer: true,
            items: true,
            payments: {
              where: { status: PaymentStatus.PENDING },
              orderBy: { createdAt: "desc" },
              take: 1,
            },
          },
        }),
      [],
    );

    const conversationIds = orders
      .map((order) => order.conversationId)
      .filter((id): id is string => Boolean(id));
    const conversations = conversationIds.length
      ? await this.prisma.safePrismaCall(
          "admin.conversation.findMany.payment_proofs",
          (prisma) =>
            prisma.conversation.findMany({
              where: { id: { in: conversationIds } },
              select: {
                id: true,
                lastIntent: true,
                messages: {
                  where: {
                    content: { contains: "comprovante de pagamento recebido" },
                  },
                  orderBy: { createdAt: "desc" },
                  take: 1,
                  select: { createdAt: true },
                },
              },
            }),
          [],
        )
      : [];
    const proofByConversation = new Map(
      conversations.map((conversation) => [conversation.id, conversation]),
    );

    return orders
      .map((order) => {
        const proofConversation = order.conversationId
          ? proofByConversation.get(order.conversationId)
          : undefined;
        const proofReceived = Boolean(
          proofConversation?.lastIntent === "PAYMENT_PROOF_RECEIVED" ||
            proofConversation?.messages.length,
        );

        return {
          id: order.id,
          conversationId: order.conversationId,
          status: order.status,
          totalCents: order.totalCents,
          proofReceived,
          proofReceivedAt: proofConversation?.messages[0]?.createdAt || null,
          customer: {
            name: order.customer.name,
            whatsappNumber: order.customer.whatsappNumber,
          },
          items: order.items.map((item) => ({
            name: item.name,
            quantity: item.quantity,
            totalCents: item.totalCents,
          })),
          payment: order.payments[0]
            ? {
                id: order.payments[0].id,
                status: order.payments[0].status,
                amountCents: order.payments[0].amountCents,
                providerTransactionId:
                  order.payments[0].providerTransactionId,
                createdAt: order.payments[0].createdAt,
              }
            : null,
          createdAt: order.createdAt,
          waitingMinutes: Math.max(
            0,
            Math.floor((Date.now() - order.createdAt.getTime()) / 60000),
          ),
        };
      })
      .sort((left, right) => {
        if (left.proofReceived !== right.proofReceived) {
          return left.proofReceived ? -1 : 1;
        }

        return left.createdAt.getTime() - right.createdAt.getTime();
      });
  }

  async orderDetails(orderId: string) {
    const order = await this.prisma.safePrismaCall(
      "admin.order.findUnique.details",
      (prisma) =>
        prisma.order.findUnique({
          where: { id: orderId },
          include: {
            customer: true,
            items: true,
            payments: { orderBy: { createdAt: "desc" } },
          },
        }),
      null,
    );

    if (!order) {
      return null;
    }

    return {
      id: order.id,
      conversationId: order.conversationId,
      status: order.status,
      totalCents: order.totalCents,
      notes: this.parseOrderNotes(order.notes),
      items: order.items.map((item) => ({
        id: item.id,
        type: item.type,
        name: item.name,
        brand: item.brand,
        presentation: item.presentation,
        description: item.description,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        totalCents: item.totalCents,
        imageUrl: item.imageUrl,
        source: item.source,
      })),
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      customer: {
        id: order.customerId,
        name: order.customer.name,
        whatsappNumber: order.customer.whatsappNumber,
      },
      payments: order.payments.map((payment) => ({
        id: payment.id,
        status: payment.status,
        provider: payment.provider,
        amountCents: payment.amountCents,
        providerTransactionId: payment.providerTransactionId,
        paymentUrl: payment.paymentUrl,
        createdAt: payment.createdAt,
        paidAt: payment.paidAt,
      })),
    };
  }

  async updateOrderStatus(orderId: string, status: OrderStatus) {
    if (status === OrderStatus.PAID) {
      return this.confirmPayment(orderId);
    }

    return this.prisma.safePrismaCall(
      "admin.order.update.status",
      async (prisma) => {
        const order = await prisma.order.update({
          where: { id: orderId },
          data: { status },
          select: { id: true, status: true, updatedAt: true },
        });

        if (status === OrderStatus.CANCELLED) {
          await prisma.payment.updateMany({
            where: {
              orderId,
              status: PaymentStatus.PENDING,
            },
            data: { status: PaymentStatus.CANCELLED },
          });
        }

        return order;
      },
    );
  }

  async confirmPayment(orderId: string) {
    const confirmedAt = new Date();
    const result = await this.prisma.safePrismaCall(
      "admin.payment.confirm_manual",
      async (prisma) => {
        const order = await prisma.order.findUnique({
          where: { id: orderId },
          include: {
            customer: true,
            payments: { orderBy: { createdAt: "desc" } },
          },
        });

        if (!order) {
          throw new NotFoundException("Pedido não encontrado.");
        }

        if (order.status === OrderStatus.CANCELLED) {
          throw new ConflictException(
            "Não é possível confirmar o pagamento de um pedido cancelado.",
          );
        }

        const pendingPayment = order.payments.find(
          (payment) => payment.status === PaymentStatus.PENDING,
        );

        if (!pendingPayment) {
          if (
            order.status === OrderStatus.PAID ||
            order.status === OrderStatus.DELIVERED ||
            order.payments.some(
              (payment) => payment.status === PaymentStatus.PAID,
            )
          ) {
            return {
              alreadyConfirmed: true,
              orderId: order.id,
              conversationId: order.conversationId,
              whatsappNumber: order.customer.whatsappNumber,
              totalCents: order.totalCents,
              paidAt:
                order.payments.find(
                  (payment) => payment.status === PaymentStatus.PAID,
                )?.paidAt || null,
            };
          }

          throw new ConflictException(
            "Este pedido não possui um pagamento Pix pendente.",
          );
        }

        const paymentUpdate = await prisma.payment.updateMany({
          where: {
            id: pendingPayment.id,
            status: PaymentStatus.PENDING,
          },
          data: {
            status: PaymentStatus.PAID,
            paidAt: confirmedAt,
          },
        });

        if (paymentUpdate.count === 0) {
          return {
            alreadyConfirmed: true,
            orderId: order.id,
            conversationId: order.conversationId,
            whatsappNumber: order.customer.whatsappNumber,
            totalCents: order.totalCents,
            paidAt: confirmedAt,
          };
        }

        await prisma.order.update({
          where: { id: order.id },
          data: { status: OrderStatus.PAID },
        });

        if (order.conversationId) {
          await prisma.conversation.updateMany({
            where: { id: order.conversationId },
            data: {
              status: ConversationStatus.OPEN,
              pendingAction: ConversationState.IDLE,
              lastIntent: `PAYMENT_CONFIRMED:${order.id}`,
              currentMedicineQuery: null,
              currentRetailCategory: null,
              selectedPresentation: Prisma.JsonNull,
              candidateOptions: Prisma.JsonNull,
              cart: Prisma.JsonNull,
              pendingAddress: Prisma.JsonNull,
            },
          });
        }

        return {
          alreadyConfirmed: false,
          orderId: order.id,
          conversationId: order.conversationId,
          whatsappNumber: order.customer.whatsappNumber,
          totalCents: order.totalCents,
          paidAt: confirmedAt,
        };
      },
    );

    if (result.alreadyConfirmed) {
      return {
        ...result,
        status: OrderStatus.PAID,
        notificationQueued: false,
        notificationStatus: "ALREADY_CONFIRMED",
      };
    }

    let notificationQueued = false;
    let notificationStatus = "NO_CONVERSATION";

    if (result.conversationId) {
      try {
        const outbox = await this.whatsappService.queueTextMessage(
          result.conversationId,
          result.whatsappNumber,
          this.paymentConfirmedMessage(),
        );
        notificationQueued = true;
        notificationStatus = outbox?.status || "PENDING";
      } catch (error) {
        notificationStatus = "FAILED_TO_QUEUE";
        this.logger.error(
          `PAYMENT CONFIRMED, WHATSAPP NOTIFICATION FAILED: order=${orderId}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    this.logger.log(
      `PAYMENT MANUALLY CONFIRMED: order=${orderId}, notification=${notificationStatus}`,
    );

    return {
      ...result,
      status: OrderStatus.PAID,
      notificationQueued,
      notificationStatus,
    };
  }

  async sendManualMessage(conversationId: string, text: string) {
    const conversation = await this.prisma.safePrismaCall(
      "admin.conversation.findUnique.manual_message",
      (prisma) =>
        prisma.conversation.findUnique({
          where: { id: conversationId },
          include: { customer: true },
        }),
    );

    if (!conversation) {
      throw new Error("Conversa não encontrada.");
    }

    try {
      const result = await this.whatsappService.sendTextMessage(
        conversation.customer.whatsappNumber,
        text,
      );

      await this.prisma.safePrismaCall(
        "admin.message.create.manual_outbound_sent",
        (prisma) =>
          prisma.message.create({
            data: {
              conversationId,
              whatsappId: result.whatsappMessageId,
              direction: MessageDirection.OUTBOUND,
              role: MessageRole.ASSISTANT,
              status: MessageStatus.SENT,
              content: text,
              rawPayload: { manual: true },
            },
          }),
      );

      return { sent: true, whatsappMessageId: result.whatsappMessageId };
    } catch (error) {
      await this.prisma.safePrismaCall(
        "admin.message.create.manual_outbound_failed",
        (prisma) =>
          prisma.message.create({
            data: {
              conversationId,
              direction: MessageDirection.OUTBOUND,
              role: MessageRole.ASSISTANT,
              status: MessageStatus.FAILED,
              content: text,
              rawPayload: {
                manual: true,
                error: error instanceof Error ? error.message : "Erro desconhecido",
              },
            },
          }),
        undefined,
      );

      throw error;
    }
  }

  async resetConversation(conversationId: string) {
    return this.prisma.safePrismaCall("admin.conversation.update.reset", (prisma) =>
      prisma.conversation.update({
        where: { id: conversationId },
        data: {
          lastIntent: null,
          pendingAction: ConversationState.IDLE,
          lastMedicine: null,
          currentMedicineQuery: null,
          currentRetailCategory: null,
          selectedPresentation: Prisma.JsonNull,
          candidateOptions: Prisma.JsonNull,
          cart: Prisma.JsonNull,
          pendingAddress: Prisma.JsonNull,
        },
        select: { id: true, pendingAction: true, updatedAt: true },
      }),
    );
  }

  async closeConversation(conversationId: string) {
    return this.prisma.safePrismaCall("admin.conversation.update.close", (prisma) =>
      prisma.conversation.update({
        where: { id: conversationId },
        data: { status: ConversationStatus.CLOSED, pendingAction: ConversationState.IDLE },
        select: { id: true, status: true, updatedAt: true },
      }),
    );
  }

  async errors(limit = 30) {
    const take = this.clampLimit(limit, 100);
    const [failedMessages, failedPayments, stalePix, cancelledOrders] =
      await Promise.all([
        this.prisma.safePrismaCall(
          "admin.message.findMany.failed",
          (prisma) =>
            prisma.message.findMany({
              where: { status: MessageStatus.FAILED },
              orderBy: { createdAt: "desc" },
              take,
              include: { conversation: { include: { customer: true } } },
            }),
          [],
        ),
        this.prisma.safePrismaCall(
          "admin.payment.findMany.failed",
          (prisma) =>
            prisma.payment.findMany({
              where: { status: PaymentStatus.FAILED },
              orderBy: { createdAt: "desc" },
              take,
              include: { order: { include: { customer: true } } },
            }),
          [],
        ),
        this.countPayments({ status: PaymentStatus.PENDING }),
        this.countOrders({ status: OrderStatus.CANCELLED }),
      ]);

    return {
      summary: {
        failedMessages: failedMessages.length,
        failedPayments: failedPayments.length,
        pendingPayments: stalePix,
        cancelledOrders,
      },
      failedMessages: failedMessages.map((message) => ({
        id: message.id,
        customer: message.conversation.customer.whatsappNumber,
        content: this.truncate(message.content, 220),
        createdAt: message.createdAt,
      })),
      failedPayments: failedPayments.map((payment) => ({
        id: payment.id,
        provider: payment.provider,
        amountCents: payment.amountCents,
        transactionId: payment.providerTransactionId,
        customer: payment.order.customer.whatsappNumber,
        createdAt: payment.createdAt,
      })),
    };
  }

  async providerRequestLogs(limit = 50) {
    const take = this.clampLimit(limit, 200);
    return this.prisma.safePrismaCall(
      "admin.provider_request_log.findMany",
      (prisma) =>
        prisma.providerRequestLog.findMany({
          orderBy: { createdAt: "desc" },
          take,
        }),
      [],
    );
  }

  async webhookEvents(limit = 50) {
    const take = this.clampLimit(limit, 200);
    return this.prisma.safePrismaCall(
      "admin.webhook_event.findMany",
      (prisma) =>
        prisma.webhookEvent.findMany({
          orderBy: { createdAt: "desc" },
          take,
          select: {
            id: true,
            provider: true,
            eventId: true,
            status: true,
            attempts: true,
            errorMessage: true,
            receivedAt: true,
            processedAt: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
      [],
    );
  }

  async whatsappOutbox(limit = 50) {
    const take = this.clampLimit(limit, 200);
    return this.prisma.safePrismaCall(
      "admin.whatsapp_outbox.findMany",
      (prisma) =>
        prisma.whatsappOutbox.findMany({
          orderBy: { createdAt: "desc" },
          take,
          include: {
            conversation: {
              include: { customer: true },
            },
          },
        }),
      [],
    );
  }

  medicinePriorities() {
    return this.medicinePriorityRules.listAll();
  }

  replaceMedicinePriorities(rules: MedicinePriorityRuleConfig[]) {
    return this.medicinePriorityRules.replaceRules(rules);
  }

  providers() {
    const cosmosTokens =
      this.tokenList("COSMOS_API_TOKENS").length ||
      this.tokenList("COSMOS_API_TOKEN").length;

    return {
      database: {
        configured: Boolean(this.env("DATABASE_URL")),
        lazy: true,
      },
      whatsapp: {
        configured: Boolean(
          this.env("WHATSAPP_ACCESS_TOKEN") &&
            this.env("WHATSAPP_PHONE_NUMBER_ID") &&
            this.env("WHATSAPP_APP_SECRET") &&
            this.env("WHATSAPP_VERIFY_TOKEN"),
        ),
        apiVersion: this.env("WHATSAPP_API_VERSION") || "v25.0",
      },
      medicines: {
        primaryProvider: this.env("MEDICINE_PRIMARY_PROVIDER") || "pharmadb",
        pharmadbConfigured: Boolean(this.env("PHARMADB_API_KEY")),
        bulapiConfigured: Boolean(this.env("BULA_API_BASE_URL")),
        manualFallback: true,
      },
      retailProducts: {
        cosmosConfigured: Boolean(
          this.env("COSMOS_API_BASE_URL") && cosmosTokens > 0,
        ),
        cosmosTokenCount: cosmosTokens,
        manualFallback: true,
      },
      payments: {
        provider: "pix_direct",
        directPixConfigured: Boolean(
          (this.env("PIX_KEY") ||
            this.env("PIX_STATIC_KEY") ||
            DEFAULT_PIX_KEY) &&
            (this.env("PIX_MERCHANT_NAME") || DEFAULT_PIX_MERCHANT_NAME) &&
            (this.env("PIX_MERCHANT_CITY") || DEFAULT_PIX_MERCHANT_CITY),
        ),
        confirmationMode: "manual",
        amountEmbedded: true,
      },
      admin: {
        protected: Boolean(this.env("ADMIN_TOKEN")),
      },
    };
  }

  async database() {
    try {
      await this.prisma.safePrismaCall("admin.database.SELECT_1", (prisma) =>
        prisma.$queryRaw`SELECT 1`,
      );
      return { configured: Boolean(this.env("DATABASE_URL")), connected: true };
    } catch (error) {
      return {
        configured: Boolean(this.env("DATABASE_URL")),
        connected: false,
        error: error instanceof Error ? error.message : "Erro desconhecido",
      };
    }
  }

  private countConversations(where: Record<string, unknown>) {
    return this.prisma.safePrismaCall(
      "admin.conversation.count",
      (prisma) => prisma.conversation.count({ where }),
      0,
    );
  }

  private countMessages(where: Record<string, unknown>) {
    return this.prisma.safePrismaCall(
      "admin.message.count",
      (prisma) => prisma.message.count({ where }),
      0,
    );
  }

  private countOrders(where: Record<string, unknown>) {
    return this.prisma.safePrismaCall(
      "admin.order.count",
      (prisma) => prisma.order.count({ where }),
      0,
    );
  }

  private countPayments(where: Record<string, unknown>) {
    return this.prisma.safePrismaCall(
      "admin.payment.count",
      (prisma) => prisma.payment.count({ where }),
      0,
    );
  }

  private buildConversationWhere(filters: {
    search?: string;
    state?: string;
    status?: string;
  }) {
    const where: Prisma.ConversationWhereInput = {};
    const status = filters.status?.trim();
    const state = filters.state?.trim();
    const search = filters.search?.trim();

    if (status && this.isConversationStatus(status)) {
      where.status = status;
    }

    if (state && this.isConversationState(state)) {
      where.pendingAction = state;
    }

    if (search) {
      where.OR = [
        { customer: { whatsappNumber: { contains: search } } },
        { customer: { name: { contains: search } } },
        { currentMedicineQuery: { contains: search } },
        { currentRetailCategory: { contains: search } },
        { messages: { some: { content: { contains: search } } } },
      ];
    }

    return where;
  }

  private isConversationStatus(value: string): value is ConversationStatus {
    return Object.values(ConversationStatus).includes(value as ConversationStatus);
  }

  private isConversationState(value: string): value is ConversationState {
    return Object.values(ConversationState).includes(value as ConversationState);
  }

  private parseOrderNotes(notes: string | null) {
    if (!notes) {
      return { items: [], address: null, conversationId: null };
    }

    try {
      const parsed = JSON.parse(notes) as {
        items?: unknown;
        address?: unknown;
        conversationId?: string;
      };

      return {
        items: this.asArray(parsed.items),
        address: this.asObject(parsed.address),
        conversationId: parsed.conversationId || null,
      };
    } catch {
      return { items: [], address: null, conversationId: null, raw: notes };
    }
  }

  private paymentConfirmedMessage() {
    return [
      "Pagamento confirmado.",
      "",
      "Seu pedido já foi encaminhado para separação pela Raia Delivery.",
      "Nossa equipe seguirá com a entrega e avisará você por aqui.",
    ].join("\n");
  }

  private resolveAttentionReason(conversation: {
    pendingAction: ConversationState;
    updatedAt: Date;
    messages: Array<{ status: MessageStatus }>;
  }) {
    if (conversation.messages.some((message) => message.status === MessageStatus.FAILED)) {
      return "Mensagem com falha";
    }

    if (conversation.pendingAction !== ConversationState.IDLE) {
      return `Aguardando ${conversation.pendingAction}`;
    }

    if (conversation.updatedAt.getTime() < Date.now() - 20 * 60 * 1000) {
      return "Sem resposta há mais de 20 minutos";
    }

    return "Revisar conversa";
  }

  private asArray(value: unknown) {
    return Array.isArray(value) ? value : [];
  }

  private asObject(value: unknown) {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  }

  private env(name: string) {
    return sanitizeEnv(this.configService.get<string>(name) ?? process.env[name]);
  }

  private tokenList(name: string) {
    return this.env(name)
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean);
  }

  private clampLimit(limit: number, max = 50) {
    return Math.min(Math.max(Number(limit) || 20, 1), max);
  }

  private truncate(value: string, max: number) {
    return value.length > max ? `${value.slice(0, max - 1)}...` : value;
  }
}
