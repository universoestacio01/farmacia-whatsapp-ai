const assert = require("node:assert/strict");
const { Logger } = require("@nestjs/common");
const {
  ConversationState,
  ConversationStatus,
  OrderStatus,
  PaymentStatus,
} = require("@prisma/client");
const { AdminService } = require("../dist/admin/admin.service");

Logger.overrideLogger(false);

class FakePrisma {
  constructor() {
    this.orderRecord = {
      id: "order_manual_payment",
      conversationId: "conversation_manual_payment",
      customerId: "customer_manual_payment",
      status: OrderStatus.PENDING_PAYMENT_MANUAL,
      totalCents: 4990,
      createdAt: new Date("2026-08-12T12:00:00.000Z"),
      items: [
        {
          id: "item_manual_payment",
          name: "Dorflex",
          quantity: 1,
          totalCents: 4990,
        },
      ],
      customer: {
        id: "customer_manual_payment",
        name: "Cliente Teste",
        whatsappNumber: "5511999999999",
      },
      payments: [
        {
          id: "payment_manual_payment",
          orderId: "order_manual_payment",
          status: PaymentStatus.PENDING,
          amountCents: 4990,
          providerTransactionId: "pix-order-manual-payment",
          paidAt: null,
          createdAt: new Date(),
        },
      ],
    };
    this.conversationRecord = {
      id: "conversation_manual_payment",
      status: ConversationStatus.OPEN,
      pendingAction: ConversationState.WAITING_PIX,
      lastIntent: "PAYMENT_PENDING",
      cart: [{ name: "Dorflex" }],
    };

    this.order = {
      findMany: async () => [this.orderRecord],
      findUnique: async ({ where }) =>
        where.id === this.orderRecord.id ? this.orderRecord : null,
      update: async ({ where, data }) => {
        assert.equal(where.id, this.orderRecord.id);
        Object.assign(this.orderRecord, data);
        return this.orderRecord;
      },
    };
    this.payment = {
      updateMany: async ({ where, data }) => {
        const payment = this.orderRecord.payments.find(
          (item) => item.id === where.id && item.status === where.status,
        );
        if (!payment) return { count: 0 };
        Object.assign(payment, data);
        return { count: 1 };
      },
    };
    this.conversation = {
      findMany: async () => [
        {
          id: this.conversationRecord.id,
          lastIntent: "PAYMENT_PROOF_RECEIVED",
          messages: [{ createdAt: new Date("2026-08-12T12:05:00.000Z") }],
        },
      ],
      updateMany: async ({ where, data }) => {
        if (where.id !== this.conversationRecord.id) return { count: 0 };
        Object.assign(this.conversationRecord, data);
        return { count: 1 };
      },
    };
  }

  async safePrismaCall(_operationName, callback) {
    return callback(this);
  }
}

async function run() {
  const prisma = new FakePrisma();
  const notifications = [];
  const whatsappService = {
    queueTextMessage: async (conversationId, recipient, content) => {
      notifications.push({ conversationId, recipient, content });
      return { id: "outbox_payment_confirmation", status: "SENT" };
    },
  };
  const configService = { get: () => undefined };
  const priorityRules = { listAll: () => ({}), replaceRules: () => ({}) };
  const service = new AdminService(
    prisma,
    configService,
    whatsappService,
    priorityRules,
  );

  const pendingQueue = await service.pendingPaymentOrders(10);
  assert.equal(pendingQueue.length, 1);
  assert.equal(pendingQueue[0].proofReceived, true);
  assert.equal(pendingQueue[0].items[0].name, "Dorflex");

  const first = await service.confirmPayment(prisma.orderRecord.id);
  assert.equal(first.alreadyConfirmed, false);
  assert.equal(first.status, OrderStatus.PAID);
  assert.equal(first.notificationStatus, "SENT");
  assert.equal(prisma.orderRecord.status, OrderStatus.PAID);
  assert.equal(prisma.orderRecord.payments[0].status, PaymentStatus.PAID);
  assert.ok(prisma.orderRecord.payments[0].paidAt instanceof Date);
  assert.equal(
    prisma.conversationRecord.pendingAction,
    ConversationState.IDLE,
  );
  assert.match(prisma.conversationRecord.lastIntent, /PAYMENT_CONFIRMED/);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].content, /Pagamento confirmado/);
  assert.match(notifications[0].content, /separação/);

  const second = await service.confirmPayment(prisma.orderRecord.id);
  assert.equal(second.alreadyConfirmed, true);
  assert.equal(second.notificationStatus, "ALREADY_CONFIRMED");
  assert.equal(notifications.length, 1);

  prisma.orderRecord.status = OrderStatus.CANCELLED;
  prisma.orderRecord.payments[0].status = PaymentStatus.PENDING;
  await assert.rejects(
    () => service.confirmPayment(prisma.orderRecord.id),
    /pedido cancelado/i,
  );

  console.log("PASS admin manual payment confirmation");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
