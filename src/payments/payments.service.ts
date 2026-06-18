import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { OrderStatus, PaymentStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  CreatePixPaymentInput,
  PixPaymentResult,
} from "./pix/pix-provider.interface";
import {
  CreatePaymentResult,
  NormalizedPaymentStatus,
  PaymentProductItem,
  SigiloPayWebhookEvent,
} from "./payment.types";
import { SigiloPayService } from "./sigilopay.service";

interface CheckoutCartItem {
  type?: "medicine" | "retail_product";
  name: string;
  brand?: string;
  presentation?: string;
  description?: string;
  quantity: number;
  unitPrice?: number;
  total?: number;
  imageUrl?: string;
  source?: string;
}

interface CheckoutAddress {
  cep?: string;
  logradouro?: string;
  street?: string;
  bairro?: string;
  neighborhood?: string;
  localidade?: string;
  city?: string;
  uf?: string;
  state?: string;
  number?: string;
  complement?: string;
}

interface ConfirmCheckoutInput {
  conversationId: string;
  customerId: string;
  cart: CheckoutCartItem[];
  address?: CheckoutAddress | null;
  existingOrderId?: string | null;
}

interface ConfirmCheckoutResult extends CreatePaymentResult {
  orderId: string;
  totalCents: number;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly sigiloPayService: SigiloPayService,
  ) {}

  createPixPayment(input: CreatePixPaymentInput): Promise<PixPaymentResult> {
    return this.sigiloPayService.createPayment(input);
  }

  async confirmCheckout(
    input: ConfirmCheckoutInput,
  ): Promise<ConfirmCheckoutResult> {
    const totalCents = this.calculateCartTotalCents(input.cart);
    const customer = await this.prisma.safePrismaCall(
      "payments.customer.findUnique",
      (prisma) =>
        prisma.customer.findUniqueOrThrow({
          where: { id: input.customerId },
        }),
    );
    const order = input.existingOrderId
      ? await this.findOrder(input.existingOrderId, input.customerId)
      : await this.createOrder(input, totalCents);

    const reusablePayment = await this.findReusablePayment(order.id);

    if (reusablePayment) {
      return {
        orderId: order.id,
        totalCents,
        provider: "sigilopay",
        status: this.toNormalizedStatus(reusablePayment.status),
        providerTransactionId:
          reusablePayment.providerTransactionId ||
          reusablePayment.providerPaymentId ||
          undefined,
        pixCopyPaste:
          reusablePayment.pixCopyPaste || reusablePayment.pixPayload || undefined,
        pixQrCode: reusablePayment.pixQrCode || undefined,
        paymentUrl: reusablePayment.paymentUrl || undefined,
        expiresAt: reusablePayment.expiresAt || undefined,
        rawResponse: reusablePayment.rawResponse || undefined,
        manualFallback: false,
      };
    }

    if (!this.shouldUseSigiloPay()) {
      const message =
        "SigiloPay não configurada. Verifique PIX_PROVIDER, SIGILOPAY_ENABLED e credenciais.";
      this.logger.error(`SIGILOPAY PIX CREATION FAILED: ${message}`);
      return this.pixFailureResult(order.id, totalCents, message);
    }

    let payment: PixPaymentResult;

    try {
      payment = await this.sigiloPayService.createPayment({
        orderId: order.id,
        amountCents: totalCents,
        customerName: customer.name || undefined,
        customerPhone: customer.whatsappNumber,
        items: this.toPaymentItems(input.cart),
        callbackUrl: this.getCallbackUrl(),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "erro desconhecido";
      this.logger.error(
        `SIGILOPAY PIX CREATION FAILED: ${message}`,
        error instanceof Error ? error.stack : undefined,
      );

      return this.pixFailureResult(order.id, totalCents, message);
    }

    await this.persistSigiloPayPaymentSafely(order.id, totalCents, payment);

    return this.pixSuccessResult(order.id, totalCents, payment);
  }

  async findLatestPaymentForCustomer(customerId: string) {
    return this.prisma.safePrismaCall(
      "payments.order.findFirst.latest_payment",
      (prisma) =>
        prisma.order.findFirst({
          where: { customerId },
          orderBy: { createdAt: "desc" },
          include: {
            payments: {
              orderBy: { createdAt: "desc" },
              take: 1,
            },
          },
        }),
    );
  }

  async handleSigiloPayWebhook(payload: SigiloPayWebhookEvent) {
    const transactionId = payload.transaction?.id;

    if (
      payload.event !== "TRANSACTION_PAID" ||
      payload.transaction?.status !== "COMPLETED" ||
      !transactionId
    ) {
      this.logger.warn("SIGILOPAY WEBHOOK IGNORED: invalid paid transaction payload");
      return { notified: false as const, whatsappNumber: null, message: null };
    }

    const payment = await this.prisma.safePrismaCall(
      "payments.payment.findFirst.webhook",
      (prisma) =>
        prisma.payment.findFirst({
          where: {
            providerTransactionId: transactionId,
          },
          include: {
            order: {
              include: { customer: true },
            },
          },
        }),
    );

    if (!payment) {
      this.logger.warn(
        `SIGILOPAY WEBHOOK PAYMENT NOT FOUND: transaction=${transactionId}`,
      );
      return { notified: false as const, whatsappNumber: null, message: null };
    }

    const status = this.resolveWebhookStatus(payload);
    const amountIsValid = this.isWebhookAmountValid(
      payment.amountCents,
      payload.transaction?.amount ?? payload.transaction?.chargeAmount,
    );

    if (status === "paid" && !amountIsValid) {
      this.logger.error(
        `SIGILOPAY WEBHOOK AMOUNT DIVERGENCE: transaction=${transactionId}`,
      );
      await this.updatePaymentRawResponse(payment.id, payload);
      return { notified: false as const, whatsappNumber: null, message: null };
    }

    if (payment.status === PaymentStatus.PAID) {
      await this.updatePaymentRawResponse(payment.id, payload);
      return { notified: false as const, whatsappNumber: null, message: null };
    }

    await this.prisma.safePrismaCall(
      "payments.payment.update.webhook_status",
      (prisma) =>
        prisma.payment.update({
          where: { id: payment.id },
          data: {
            status: this.toPrismaPaymentStatus(status),
            paidAt:
              status === "paid"
                ? this.parsePaymentDate(payload.transaction?.payedAt)
                : payment.paidAt,
            rawResponse: this.toJson(payload),
          },
        }),
    );

    if (status !== "paid") {
      return { notified: false as const, whatsappNumber: null, message: null };
    }

    await this.prisma.safePrismaCall(
      "payments.order.update.paid",
      (prisma) =>
        prisma.order.update({
          where: { id: payment.orderId },
          data: { status: OrderStatus.PAID },
        }),
    );

    return {
      notified: true as const,
      whatsappNumber: payment.order.customer.whatsappNumber,
      message: this.formatPaidDeliveryMessage(),
    };
  }

  private async createOrder(input: ConfirmCheckoutInput, totalCents: number) {
    return this.prisma.safePrismaCall("payments.order.create", (prisma) =>
      prisma.order.create({
        data: {
          customerId: input.customerId,
          status: OrderStatus.CONFIRMED,
          totalCents,
          notes: JSON.stringify({
            conversationId: input.conversationId,
            address: input.address,
            items: input.cart,
          }),
        },
      }),
    );
  }

  private async findOrder(orderId: string, customerId: string) {
    return this.prisma.safePrismaCall("payments.order.findFirst", (prisma) =>
      prisma.order.findFirstOrThrow({
        where: { id: orderId, customerId },
      }),
    );
  }

  private async findReusablePayment(orderId: string) {
    return this.prisma.safePrismaCall(
      "payments.payment.findFirst.reusable",
      (prisma) =>
        prisma.payment.findFirst({
          where: {
            orderId,
            provider: "sigilopay",
            status: PaymentStatus.PENDING,
            OR: [
              { pixCopyPaste: { not: null } },
              { pixPayload: { not: null } },
            ],
          },
          orderBy: { createdAt: "desc" },
        }),
    );
  }

  private async persistSigiloPayPaymentSafely(
    orderId: string,
    totalCents: number,
    payment: PixPaymentResult,
  ) {
    try {
      await this.prisma.safePrismaCall(
        "payments.payment.create.sigilopay",
        (prisma) =>
          prisma.payment.create({
            data: {
              orderId,
              status: PaymentStatus.PENDING,
              amountCents: totalCents,
              amount: this.centsToMoney(totalCents),
              provider: "sigilopay",
              providerPaymentId: payment.providerPaymentId,
              providerTransactionId:
                payment.providerTransactionId || payment.providerPaymentId,
              pixPayload: payment.pixPayload || payment.pixCopyPaste,
              pixCopyPaste: payment.pixCopyPaste || payment.pixPayload,
              paymentUrl: payment.paymentUrl,
              expiresAt: payment.expiresAt,
              rawResponse: this.toJson(
                this.minimizeSigiloPayRawResponse(payment.rawResponse),
              ),
            },
          }),
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "erro desconhecido";
      this.logger.error(
        `SIGILOPAY PIX CREATED BUT PAYMENT PERSISTENCE FAILED: ${message}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  private pixSuccessResult(
    orderId: string,
    totalCents: number,
    payment: PixPaymentResult,
  ): ConfirmCheckoutResult {
    return {
      orderId,
      totalCents,
      provider: "sigilopay",
      status: "pending",
      providerTransactionId:
        payment.providerTransactionId || payment.providerPaymentId,
      pixCopyPaste: payment.pixCopyPaste || payment.pixPayload,
      pixQrCode: payment.pixQrCode,
      paymentUrl: payment.paymentUrl,
      expiresAt: payment.expiresAt,
      rawResponse: payment.rawResponse,
      manualFallback: false,
    };
  }

  private pixFailureResult(
    orderId: string,
    totalCents: number,
    errorMessage: string,
  ): ConfirmCheckoutResult {
    return {
      orderId,
      totalCents,
      provider: "sigilopay",
      status: "failed",
      manualFallback: false,
      pixCreationFailed: true,
      errorMessage,
    };
  }

  private shouldUseSigiloPay() {
    return (
      this.configService.get<string>("PIX_PROVIDER") === "sigilopay" &&
      this.sigiloPayService.isEnabled() &&
      this.sigiloPayService.isConfigured()
    );
  }

  private getCallbackUrl() {
    return (
      this.configService.get<string>("SIGILOPAY_CALLBACK_URL")?.trim() ||
      "https://io-web.link/webhook/sigilopay"
    );
  }

  private toPaymentItems(cart: CheckoutCartItem[]): PaymentProductItem[] {
    return cart.map((item, index) => ({
      id: `item_${index + 1}`,
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice || Number(((item.total || 0) / item.quantity).toFixed(2)),
      physical: true,
    }));
  }

  private calculateCartTotalCents(cart: CheckoutCartItem[]) {
    const total = cart.reduce((sum, item) => sum + (item.total || 0), 0);
    return Math.round(total * 100);
  }

  private centsToMoney(cents: number) {
    return Number((cents / 100).toFixed(2));
  }

  private resolveWebhookStatus(payload: SigiloPayWebhookEvent) {
    if (payload.event === "TRANSACTION_PAID") {
      return "paid" as NormalizedPaymentStatus;
    }

    return this.sigiloPayService.mapStatus(payload.transaction?.status);
  }

  private isWebhookAmountValid(expectedCents: number, receivedAmount?: number) {
    if (receivedAmount === undefined || receivedAmount === null) {
      return true;
    }

    const receivedCents = Math.round(receivedAmount * 100);
    return receivedCents >= expectedCents;
  }

  private async updatePaymentRawResponse(
    paymentId: string,
    payload: SigiloPayWebhookEvent,
  ) {
    await this.prisma.safePrismaCall(
      "payments.payment.update.raw_response",
      (prisma) =>
        prisma.payment.update({
          where: { id: paymentId },
          data: { rawResponse: this.toJson(payload) },
        }),
      undefined,
    );
  }

  private toPrismaPaymentStatus(status: NormalizedPaymentStatus) {
    const statuses: Record<NormalizedPaymentStatus, PaymentStatus> = {
      pending: PaymentStatus.PENDING,
      paid: PaymentStatus.PAID,
      expired: PaymentStatus.EXPIRED,
      cancelled: PaymentStatus.CANCELLED,
      failed: PaymentStatus.FAILED,
    };

    return statuses[status];
  }

  private toNormalizedStatus(status: PaymentStatus): NormalizedPaymentStatus {
    const statuses: Record<PaymentStatus, NormalizedPaymentStatus> = {
      PENDING: "pending",
      PAID: "paid",
      EXPIRED: "expired",
      FAILED: "failed",
      CANCELLED: "cancelled",
    };

    return statuses[status];
  }

  private parsePaymentDate(value: string | null | undefined) {
    if (!value) {
      return new Date();
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? new Date() : date;
  }

  private formatPaidDeliveryMessage() {
    return [
      "Pagamento confirmado ✅",
      "",
      "Seu pedido já está sendo separado.",
      "",
      "🚚 Entrega grátis por motoboy",
      "⏱️ Prazo estimado: até 30 minutos",
    ].join("\n");
  }

  private formatPaymentConfirmedMessage() {
    return [
      "Pagamento confirmado ✅",
      "",
      "Seu pedido foi recebido e será preparado para entrega.",
    ].join("\n");
  }

  private toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
    if (value === undefined || value === null) {
      return Prisma.JsonNull;
    }

    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }

  private minimizeSigiloPayRawResponse(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }

    const response = value as Record<string, unknown>;
    const pix = this.asRecord(response.pix);
    const order = this.asRecord(response.order);

    return {
      responseType: response.responseType,
      transactionId: response.transactionId,
      status: response.status,
      fee: response.fee,
      order: order
        ? {
            id: order.id,
            url: order.url,
            receiptUrl: order.receiptUrl,
          }
        : undefined,
      pix: pix
        ? {
            code: pix.code,
            base64Exists: Boolean(pix.base64),
            imageExists: Boolean(pix.image),
          }
        : undefined,
    };
  }

  private asRecord(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }

    return value as Record<string, unknown>;
  }
}
