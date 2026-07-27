import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ConversationState,
  MessageStatus,
  OrderStatus,
  PaymentStatus,
} from "@prisma/client";
import { sanitizeEnv } from "../config/env-sanitize";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
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
      providers: this.providers(),
    };
  }

  async listConversations(limit = 20) {
    const take = this.clampLimit(limit);
    const conversations = await this.prisma.safePrismaCall(
      "admin.conversation.findMany",
      (prisma) =>
        prisma.conversation.findMany({
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
    const take = this.clampLimit(limit);
    const orders = await this.prisma.safePrismaCall(
      "admin.order.findMany",
      (prisma) =>
        prisma.order.findMany({
          orderBy: { createdAt: "desc" },
          take,
          include: {
            customer: true,
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
      status: order.status,
      totalCents: order.totalCents,
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
        provider: this.env("PIX_PROVIDER") || "none",
        sigilopayConfigured: Boolean(
          this.env("SIGILOPAY_PUBLIC_KEY") && this.env("SIGILOPAY_SECRET_KEY"),
        ),
        callbackUrlConfigured: Boolean(this.env("SIGILOPAY_CALLBACK_URL")),
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
