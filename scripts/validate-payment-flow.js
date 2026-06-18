const assert = require("node:assert/strict");
const { Logger } = require("@nestjs/common");
const { OrderStatus, PaymentStatus } = require("@prisma/client");
const { PaymentsService } = require("../dist/payments/payments.service");
const {
  SigiloPayWebhookController,
} = require("../dist/payments/sigilopay-webhook.controller");
const { SigiloPayService } = require("../dist/payments/sigilopay.service");

Logger.overrideLogger(false);

function config(values) {
  return {
    get(key) {
      return values[key];
    },
  };
}

class FakePrisma {
  constructor() {
    this.customerData = {
      id: "customer_1",
      whatsappNumber: "5511999999999",
      name: "Cliente Teste",
    };
    this.orders = [];
    this.payments = [];
    this.customer = {
      findUniqueOrThrow: async () => this.customerData,
    };
    this.order = {
      create: async ({ data }) => {
        const order = {
          id: `order_${this.orders.length + 1}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        this.orders.push(order);
        return order;
      },
      findFirstOrThrow: async ({ where }) => {
        const order = this.orders.find(
          (item) => item.id === where.id && item.customerId === where.customerId,
        );
        if (!order) throw new Error("order not found");
        return order;
      },
      findFirst: async ({ where }) => {
        const order = [...this.orders]
          .reverse()
          .find((item) => item.customerId === where.customerId);
        if (!order) return null;
        return {
          ...order,
          payments: this.payments
            .filter((payment) => payment.orderId === order.id)
            .slice(-1)
            .reverse(),
        };
      },
      update: async ({ where, data }) => {
        const order = this.orders.find((item) => item.id === where.id);
        Object.assign(order, data);
        return order;
      },
    };
    this.payment = {
      findFirst: async ({ where }) => {
        const payment =
          [...this.payments].reverse().find((item) => {
            if (where.orderId && item.orderId !== where.orderId) return false;
            if (where.provider && item.provider !== where.provider) return false;
            if (where.status && item.status !== where.status) return false;
            if (where.OR) {
              return where.OR.some(
                (condition) =>
                  condition.providerTransactionId ===
                    item.providerTransactionId ||
                  condition.providerPaymentId === item.providerPaymentId ||
                  (condition.pixCopyPaste?.not === null &&
                    item.pixCopyPaste !== null &&
                    item.pixCopyPaste !== undefined) ||
                  (condition.pixPayload?.not === null &&
                    item.pixPayload !== null &&
                    item.pixPayload !== undefined),
              );
            }
            return true;
          }) || null;

        if (!payment) return null;

        const order = this.orders.find((item) => item.id === payment.orderId);

        return {
          ...payment,
          order: order
            ? {
                ...order,
                customer: this.customerData,
              }
            : undefined,
        };
      },
      create: async ({ data }) => {
        const payment = {
          id: `payment_${this.payments.length + 1}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        this.payments.push(payment);
        return payment;
      },
      update: async ({ where, data }) => {
        const payment = this.payments.find((item) => item.id === where.id);
        Object.assign(payment, data);
        return payment;
      },
    };
  }

  async safePrismaCall(_operationName, callback) {
    return callback(this);
  }
}

function fakeSigiloPay(enabled = true, calls = [], options = {}) {
  return {
    isEnabled: () => enabled,
    isConfigured: () => enabled,
    async createPayment(input) {
      calls.push(input);
      if (options.fail) {
        throw new Error("SigiloPay indisponível");
      }
      return {
        provider: "sigilopay",
        providerPaymentId: `tx_${input.orderId}`,
        providerTransactionId: `tx_${input.orderId}`,
        pixPayload: "000201PIXTESTE",
        pixCopyPaste: "000201PIXTESTE",
        paymentUrl: "https://checkout.example/pagar",
        rawResponse: {
          transactionId: `tx_${input.orderId}`,
          status: "OK",
          pix: { code: "000201PIXTESTE" },
        },
      };
    },
    mapStatus(status) {
      return status === "COMPLETED" ? "paid" : "pending";
    },
  };
}

async function run() {
  const cart = [
    {
      type: "retail_product",
      name: "Sabonete Dove 90g",
      quantity: 2,
      unitPrice: 4.99,
      total: 9.98,
    },
  ];

  const disabledPrisma = new FakePrisma();
  const disabledService = new PaymentsService(
    config({ PIX_PROVIDER: "sigilopay", SIGILOPAY_ENABLED: false }),
    disabledPrisma,
    fakeSigiloPay(false),
  );
  const disabled = await disabledService.confirmCheckout({
    conversationId: "conv_1",
    customerId: "customer_1",
    cart,
  });
  assert.equal(disabled.manualFallback, false);
  assert.equal(disabled.pixCreationFailed, true);
  assert.equal(disabled.provider, "sigilopay");
  assert.equal(disabledPrisma.payments.length, 0);
  assert.equal(disabledPrisma.orders[0].status, OrderStatus.CONFIRMED);

  const failingPrisma = new FakePrisma();
  const failingCalls = [];
  const failingService = new PaymentsService(
    config({ PIX_PROVIDER: "sigilopay", SIGILOPAY_ENABLED: true }),
    failingPrisma,
    fakeSigiloPay(true, failingCalls, { fail: true }),
  );
  const failedPix = await failingService.confirmCheckout({
    conversationId: "conv_fail",
    customerId: "customer_1",
    cart,
  });
  assert.equal(failedPix.pixCreationFailed, true);
  assert.equal(failedPix.manualFallback, false);
  assert.equal(failingPrisma.payments.length, 0);

  const prisma = new FakePrisma();
  const pixCalls = [];
  const service = new PaymentsService(
    config({
      PIX_PROVIDER: "sigilopay",
      SIGILOPAY_ENABLED: true,
      SIGILOPAY_CALLBACK_URL: "https://io-web.link/webhook/sigilopay",
    }),
    prisma,
    fakeSigiloPay(true, pixCalls),
  );
  const pix = await service.confirmCheckout({
    conversationId: "conv_2",
    customerId: "customer_1",
    cart,
  });
  assert.equal(pix.manualFallback, false);
  assert.equal(pix.pixCopyPaste, "000201PIXTESTE");
  assert.equal(prisma.payments[0].status, PaymentStatus.PENDING);
  assert.equal(pixCalls[0].callbackUrl, "https://io-web.link/webhook/sigilopay");

  const reused = await service.confirmCheckout({
    conversationId: "conv_2",
    customerId: "customer_1",
    cart,
    existingOrderId: pix.orderId,
  });
  assert.equal(reused.pixCopyPaste, "000201PIXTESTE");
  assert.equal(prisma.payments.length, 1);

  const approved = await service.handleSigiloPayWebhook({
    event: "TRANSACTION_PAID",
    transaction: {
      id: `tx_${pix.orderId}`,
      status: "COMPLETED",
      amount: 9.98,
      paymentMethod: "PIX",
      payedAt: "2026-06-18T12:00:00.000Z",
    },
  });
  assert.equal(approved.notified, true);
  assert.equal(prisma.payments[0].status, PaymentStatus.PAID);
  assert.equal(prisma.orders[0].status, OrderStatus.PAID);
  assert.match(approved.message, /Entrega grátis por motoboy/);
  assert.match(approved.message, /até 30 minutos/);

  const duplicated = await service.handleSigiloPayWebhook({
    event: "TRANSACTION_PAID",
    transaction: {
      id: `tx_${pix.orderId}`,
      status: "COMPLETED",
      amount: 9.98,
      paymentMethod: "PIX",
    },
  });
  assert.equal(duplicated.notified, false);

  const sigiloPayService = new SigiloPayService(
    config({
      SIGILOPAY_WEBHOOK_TOKEN: "token-correto",
      SIGILOPAY_API_BASE_URL: "https://app.sigilopay.com.br/api/v1",
    }),
  );
  const controller = new SigiloPayWebhookController(
    {
      handleSigiloPayWebhook: async () => ({
        notified: false,
        whatsappNumber: null,
        message: null,
      }),
    },
    sigiloPayService,
    { get: () => ({ sendTextMessage: async () => undefined }) },
  );
  assert.throws(
    () =>
      controller.receive({
        event: "TRANSACTION_PAID",
        token: "token-errado",
        transaction: { id: "tx_invalid", status: "COMPLETED" },
      }),
    /Unauthorized/,
  );

  const panicController = new SigiloPayWebhookController(
    {
      handleSigiloPayWebhook: async () => {
        const error = new Error("PANIC: timer has gone away");
        error.name = "PrismaClientRustPanicError";
        throw error;
      },
    },
    new SigiloPayService(config({})),
    { get: () => ({ sendTextMessage: async () => undefined }) },
  );
  assert.deepEqual(
    panicController.receive({
      event: "TRANSACTION_PAID",
      transaction: { id: "tx_panic", status: "COMPLETED" },
    }),
    { received: true },
  );

  console.log("Payment flow validations passed.");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
