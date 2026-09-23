const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  associateReceipts,
  buildSalesReport,
  salesDay,
} = require("../dist/admin/admin-sales");
const { AdminService } = require("../dist/admin/admin.service");
const { AdminController } = require("../dist/admin/admin.controller");
const date = (time) => new Date(`2026-09-23T${time}:00Z`);
const order = (id, time = "12:00", extra = {}) => ({
  id,
  createdAt: date(time),
  conversationId: "chat",
  totalCents: 1000,
  status: "PENDING_PAYMENT_MANUAL",
  customer: { name: "Demo", whatsappNumber: "demo" },
  items: [],
  payments: [{ createdAt: date(time), status: "PENDING" }],
  ...extra,
});
const proof = (...times) => [
  { id: "chat", messages: times.map((time) => ({ createdAt: date(time) })) },
];
const report = (orders, receipts = new Map()) =>
  buildSalesReport(orders, receipts, "2026-09-22", "2026-09-23");

test("receipt belongs only to latest checkout, regardless of conversation intent", () => {
  const receipts = associateReceipts(
    [order("a"), order("b", "13:00")],
    proof("13:05"),
  );
  assert.deepEqual([...receipts.keys()], ["b"]);
});
test("retains historical first receipt and ignores repeated uploads", () => {
  const receipts = associateReceipts(
    [order("a")],
    proof("12:08", "12:05", "12:09"),
  );
  assert.equal(receipts.get("a").toISOString(), date("12:05").toISOString());
  assert.equal(report([order("a")], receipts).summary.count, 1);
});
test("receipts before checkout or payment do not count", () => {
  assert.equal(associateReceipts([order("a")], proof("11:00")).size, 0);
  assert.equal(
    associateReceipts(
      [order("a", "12:00", { payments: [{ createdAt: date("12:10") }] })],
      proof("12:05"),
    ).size,
    0,
  );
});
test("ambiguous simultaneous orders cannot both inherit a receipt", () => {
  assert.equal(
    associateReceipts([order("a"), order("b")], proof("12:05")).size,
    0,
  );
});
test("new cancelled checkout blocks attribution to old checkout", () => {
  const orders = [order("a"), order("b", "13:00", { status: "CANCELLED" })];
  const receipts = associateReceipts(orders, proof("13:05"));
  assert.equal(receipts.has("a"), false);
  assert.equal(report(orders, receipts).summary.count, 0);
});
test("payment alone counts; paid plus receipt or multiple payments counts once", () => {
  const orders = [
    order("a", "12:00", {
      payments: [
        { status: "PAID", createdAt: date("12:00") },
        { status: "PAID", createdAt: date("12:01") },
      ],
    }),
  ];
  const result = report(orders, new Map([["a", date("12:05")]]));
  assert.equal(result.summary.count, 1);
  assert.equal(result.summary.settledCents, 1000);
  assert.equal(result.summary.pendingCount, 0);
});
test("unverified receipt is sale but not payment; reading has no state mutations", () => {
  const orders = [order("a")];
  const before = JSON.stringify(orders);
  const result = report(orders, new Map([["a", date("12:05")]]));
  assert.equal(result.rows[0].saleStatus, "AWAITING_SETTLEMENT");
  assert.equal(result.summary.pendingCents, 1000);
  assert.equal(result.summary.settledCents, 0);
  assert.equal(JSON.stringify(orders), before);
});
test("draft, cancelled and no-receipt pending orders are excluded", () => {
  assert.equal(
    report(
      [
        order("a"),
        order("b", "12:00", { status: "DRAFT" }),
        order("c", "12:00", { status: "CANCELLED" }),
      ],
      new Map([
        ["b", date("12:05")],
        ["c", date("12:05")],
      ]),
    ).summary.count,
    0,
  );
});
test("sale day follows Sao Paulo, including midnight boundary", () => {
  assert.equal(salesDay(new Date("2026-09-23T02:59:59Z")), "2026-09-22");
  assert.equal(salesDay(new Date("2026-09-23T03:00:00Z")), "2026-09-23");
});
test("newest sales first; empty days retained; totals and average exact in cents", () => {
  const result = report(
    [order("a"), order("b", "13:00", { totalCents: 2001 })],
    new Map([
      ["a", date("12:05")],
      ["b", date("13:05")],
    ]),
  );
  assert.deepEqual(
    result.rows.map((row) => row.id),
    ["b", "a"],
  );
  assert.equal(result.days[0].count, 0);
  assert.equal(result.days[1].totalCents, 3001);
  assert.equal(result.summary.averageCents, 1501);
});
test("empty report has zero finite metrics", () => {
  const result = report([]);
  assert.equal(result.summary.averageCents, 0);
  assert.equal(result.days.length, 2);
});
test("sales endpoint requires admin authentication", () => {
  const controller = new AdminController(
    {},
    { get: (key) => (key === "ADMIN_TOKEN" ? "test-token" : undefined) },
  );
  assert.throws(() => controller.sales(undefined, "30"));
});
test("invalid period rejected without database calls", async () => {
  const service = new AdminService({}, {}, {}, {});
  await assert.rejects(service.sales("-1"), /Período inválido/);
});
test("database outage cannot appear as zero sales", async () => {
  const service = new AdminService(
    { safePrismaCall: async () => null },
    {},
    {},
    {},
  );
  await assert.rejects(service.sales("30"), /atualizar as vendas/);
});
test("entire period paginated beyond 500; no calls to WhatsApp or payment writes", async () => {
  let pages = 0;
  const rows = Array.from({ length: 501 }, (_, i) =>
    order(String(i), "12:00", {
      conversationId: null,
      createdAt: new Date(),
      payments: [{ status: "PAID", createdAt: new Date() }],
    }),
  );
  const prisma = {
    order: {
      findMany: async (args) => {
        assert.equal(args.take, 500);
        pages++;
        return args.cursor ? rows.slice(500) : rows.slice(0, 500);
      },
    },
  };
  prisma.safePrismaCall = async (_name, callback) => callback(prisma);
  const service = new AdminService(prisma, {}, {}, {});
  const result = await service.sales("30");
  assert.equal(pages, 2);
  assert.equal(result.summary.count, 501);
  assert.equal(result.summary.totalCents, 501000);
});
test("pending queue requests newest first before applying limit; proof never bumps older order", async () => {
  const older = order("a");
  const newer = order("b", "13:00");
  const prisma = {
    safePrismaCall: async (operation, callback) => {
      if (operation === "admin.order.receipt_boundaries") return [older, newer];
      if (operation === "admin.conversation.findMany.payment_proofs")
        return proof("12:05");
      return callback({
        order: {
          findMany: async (args) => {
            assert.deepEqual(args.orderBy, [
              { createdAt: "desc" },
              { id: "desc" },
            ]);
            assert.equal(args.take, 10);
            return [newer, older];
          },
        },
      });
    },
  };
  const result = await new AdminService(
    prisma,
    {},
    {},
    {},
  ).pendingPaymentOrders(10);
  assert.deepEqual(
    result.map((row) => row.id),
    ["b", "a"],
  );
  assert.equal(result[0].proofReceived, false);
  assert.equal(result[1].proofReceived, true);
});
test("receipt lookup only accepts inbound customer proof marker, not outbound messages", async () => {
  const prisma = {
    order: { findMany: async () => [order("a")] },
    conversation: {
      findMany: async (args) => {
        assert.deepEqual(args.select.messages.where, {
          direction: "INBOUND",
          role: "CUSTOMER",
          content: "[comprovante de pagamento recebido]",
        });
        assert.equal(args.select.messages.take, undefined);
        return proof("12:05");
      },
    },
  };
  prisma.safePrismaCall = async (_operation, callback) => callback(prisma);
  const result = await new AdminService(
    prisma,
    {},
    {},
    {},
  ).pendingPaymentOrders(10);
  assert.equal(result[0].proofReceived, true);
});
