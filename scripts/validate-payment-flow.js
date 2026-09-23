const assert = require("node:assert/strict");
const { Logger } = require("@nestjs/common");
const { OrderStatus, PaymentStatus } = require("@prisma/client");
const { DirectPixService } = require("../dist/payments/direct-pix.service");
const { PaymentsService } = require("../dist/payments/payments.service");
const {
  isValidPixBrCodeCrc,
} = require("../dist/utils/pix-br-code.util");

Logger.overrideLogger(false);

const PIX_KEY = "c9d7eec2-539a-4d7a-86ec-078d2abf4d75";

function config(values = {}) {
  return {
    get(key) {
      return values[key];
    },
  };
}

class FakePrisma {
  constructor() {
    this.orders = [];
    this.payments = [];
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
    this.orderItem = {
      createMany: async () => ({ count: 1 }),
    };
    this.payment = {
      findFirst: async ({ where }) =>
        [...this.payments].reverse().find((item) => {
          if (where.orderId && item.orderId !== where.orderId) return false;
          if (where.provider && item.provider !== where.provider) return false;
          if (where.status && item.status !== where.status) return false;
          if (where.idempotencyKey && item.idempotencyKey !== where.idempotencyKey) {
            return false;
          }
          if (where.OR) {
            return where.OR.some(
              (condition) =>
                (condition.pixCopyPaste?.not === null && item.pixCopyPaste) ||
                (condition.pixPayload?.not === null && item.pixPayload),
            );
          }
          return true;
        }) || null,
      create: async ({ data }) => this.createPayment(data),
      upsert: async ({ where, update, create }) => {
        const existing = this.payments.find(
          (item) => item.idempotencyKey === where.idempotencyKey,
        );
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        return this.createPayment(create);
      },
      update: async ({ where, data }) => {
        const payment = this.payments.find((item) => item.id === where.id);
        Object.assign(payment, data);
        return payment;
      },
    };
  }

  createPayment(data) {
    const payment = {
      id: `payment_${this.payments.length + 1}`,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    };
    this.payments.push(payment);
    return payment;
  }

  async safePrismaCall(_operationName, callback) {
    return callback(this);
  }
}

function legacySigiloPayStub() {
  return {
    mapStatus(status) {
      return status === "COMPLETED" ? "paid" : "pending";
    },
  };
}

function directPixService() {
  return new DirectPixService(
    config({
      PIX_KEY,
      PIX_MERCHANT_NAME: "RAIA FARMACIA",
      PIX_MERCHANT_CITY: "SAO PAULO",
    }),
  );
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
  const prisma = new FakePrisma();
  const address = {
    cep: "88301080", logradouro: "Rua Teste", bairro: "Centro",
    localidade: "Itajai", uf: "SC", number: "10",
  };
  const service = new PaymentsService(
    prisma,
    legacySigiloPayStub(),
    directPixService(),
  );

  const payment = await service.confirmCheckout({
    conversationId: "conv_direct_pix",
    customerId: "customer_1",
    cart,
    address,
  });

  assert.equal(payment.provider, "pix_direct");
  assert.equal(payment.status, "pending");
  assert.equal(isValidPixBrCodeCrc(payment.pixCopyPaste), true);
  assert.match(payment.pixCopyPaste, /54049\.98/);
  assert.match(payment.pixCopyPaste, new RegExp(PIX_KEY));
  assert.equal(payment.paymentUrl, undefined);
  assert.match(payment.providerTransactionId, /^RD[A-F0-9]{23}$/);
  assert.equal(prisma.payments.length, 1);
  assert.equal(prisma.payments[0].provider, "pix_direct");
  assert.equal(prisma.payments[0].status, PaymentStatus.PENDING);
  assert.equal(prisma.orders[0].status, OrderStatus.PENDING_PAYMENT_MANUAL);

  const reused = await service.confirmCheckout({
    conversationId: "conv_direct_pix",
    customerId: "customer_1",
    cart,
    address,
    existingOrderId: payment.orderId,
  });

  assert.equal(reused.pixCopyPaste, payment.pixCopyPaste);
  assert.equal(prisma.payments.length, 1);

  const directPix = await directPixService().createPayment({
    orderId: "order_direct",
    amountCents: 200,
  });
  assert.equal(directPix.provider, "pix_direct");
  assert.match(directPix.pixCopyPaste, /54042\.00/);
  assert.equal(isValidPixBrCodeCrc(directPix.pixCopyPaste), true);
  assert.equal(directPix.rawResponse.amountCents, 200);
  assert.equal(directPix.rawResponse.automaticConfirmation, false);

  const failingPrisma = new FakePrisma();
  failingPrisma.payment.upsert = async () => {
    throw new Error("database unavailable");
  };
  const failingService = new PaymentsService(
    failingPrisma,
    legacySigiloPayStub(),
    directPixService(),
  );
  const failed = await failingService.confirmCheckout({
    conversationId: "conv_failure",
    address,
    customerId: "customer_1",
    cart,
  });
  assert.equal(failed.provider, "pix_direct");
  assert.equal(failed.pixCreationFailed, true);
  assert.equal(failed.pixCopyPaste, undefined);

  console.log("Direct Pix payment flow validations passed.");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
