// Local-only demo. No environment file, database, gateway or WhatsApp connection.
const express = require("express");
const path = require("node:path");
const { buildSalesReport, salesDay } = require("../dist/admin/admin-sales");

function createAdminPreview() {
  const app = express();
  const counts = {};
  const now = new Date().toISOString();
  const customers = [
    {
      id: "c1",
      name: "Marina Costa (demo)",
      whatsappNumber: "Cliente demonstrativo 01",
    },
    {
      id: "c2",
      name: "João Almeida (demo)",
      whatsappNumber: "Cliente demonstrativo 02",
    },
  ];
  const orders = Array.from({ length: 4 }, (_, i) => ({
    id: `order-demo-${i + 1}`,
    conversationId: `chat${(i % 2) + 1}`,
    customer: customers[i % 2],
    status: i === 3 ? "PAID" : "PENDING_PAYMENT_MANUAL",
    totalCents: 3790 + i * 1000,
    createdAt: new Date(Date.now() - i * 35 * 60000).toISOString(),
    updatedAt: now,
    waitingMinutes: i * 35,
    proofReceived: i === 1,
    notes: {
      address: {
        logradouro: "Rua Demonstrativa",
        number: "100",
        bairro: "Centro",
        localidade: "Itajaí",
        uf: "SC",
        cep: "88301-080",
      },
      addressComplement: "Sala de demonstração",
      addressReference: "Entrada principal",
    },
    items: [
      {
        id: `item${i}`,
        name: i % 2 ? "Shampoo Seda 325ml" : "Sabonete Dove 90g",
        quantity: 1,
        unitPriceCents: 3790 + i * 1000,
        totalCents: 3790 + i * 1000,
        type: "retail_product",
        source: "preco_popular",
      },
    ],
    payments: [
      {
        id: `payment${i}`,
        status: i === 3 ? "PAID" : "PENDING",
        provider: "pix_direct",
        amountCents: 3790 + i * 1000,
        createdAt: now,
        paidAt: i === 3 ? now : null,
      },
    ],
  }));
  const salesOrders = Array.from({ length: 70 }, (_, i) => {
    const createdAt = new Date(Date.now() - (i % 35) * 86400000 - (i % 6) * 3600000);
    const totalCents = 2890 + (i * 1379) % 22000;
    return { ...orders[i % 4], id: `order-demo-${i + 5}`, createdAt, totalCents,
      status: i % 3 ? "PAID" : "PENDING_PAYMENT_MANUAL",
      proofReceived: i % 4 !== 0,
      payments: [{ ...orders[0].payments[0], createdAt, status: i % 3 ? "PAID" : "PENDING", amountCents: totalCents }],
    };
  });
  const conversations = customers.map((customer, i) => ({
    id: `chat${i + 1}`,
    customerName: customer.name,
    whatsappNumber: customer.whatsappNumber,
    pendingAction: i ? "WAITING_QUANTITY" : "WAITING_PIX",
    status: "OPEN",
    updatedAt: now,
    cartItems: 2,
    lastMessage: {
      content: i ? "Gostaria de duas unidades." : "Enviei o comprovante.",
    },
  }));
  const messages = Object.fromEntries(
    conversations.map((chat, i) => [
      chat.id,
      [
        {
          id: `m${i}-1`,
          direction: "INBOUND",
          status: "RECEIVED",
          content: `Olá, sou ${customers[i].name}.`,
          createdAt: now,
        },
        {
          id: `m${i}-2`,
          direction: "OUTBOUND",
          status: "SENT",
          content: "Olá! Aqui é a Raia Delivery. Como posso ajudar?",
          createdAt: now,
        },
        {
          id: `m${i}-3`,
          direction: "INBOUND",
          status: "RECEIVED",
          content: chat.lastMessage.content,
          createdAt: now,
        },
      ],
    ]),
  );
  let rules = [
    {
      principleActive: "dipirona",
      dosageMg: 500,
      quantity: 10,
      formGroup: "comprimido",
      brand: "Novalgina",
      priority: 1000,
      enabled: true,
    },
  ];
  const logs = [
    {
      id: "log1",
      traceId: "demo-trace-01",
      provider: "preco_popular",
      operation: "search",
      query: "dipirona",
      statusCode: 200,
      durationMs: 436,
      resultsFound: 18,
      resultsAfterFilter: 3,
      outcome: "SUCCESS",
      createdAt: now,
    },
    {
      id: "log2",
      traceId: "demo-trace-02",
      provider: "pharmadb",
      operation: "search",
      query: "Venvanse",
      statusCode: 429,
      durationMs: 181,
      resultsFound: 0,
      resultsAfterFilter: 0,
      outcome: "FAILED",
      failureReason: "Limite de consultas atingido (exemplo fictício).",
      createdAt: now,
    },
    {
      id: "log3",
      traceId: "demo-trace-03",
      provider: "preco_popular",
      operation: "search",
      query: "Shampoo Seda",
      statusCode: 200,
      durationMs: 283,
      resultsFound: 12,
      resultsAfterFilter: 3,
      outcome: "SUCCESS",
      createdAt: now,
    },
    {
      id: "log4",
      traceId: "demo-trace-04",
      provider: "cosmos",
      operation: "search",
      query: "Produto exemplo",
      statusCode: 200,
      durationMs: 229,
      resultsFound: 0,
      resultsAfterFilter: 0,
      outcome: "EMPTY",
      createdAt: now,
    },
  ];
  app.use(express.json());
  app.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.get("/admin/api/session", (_req, res) =>
    res.json({ protected: true, authenticated: true, demo: true }),
  );
  app.use("/admin/api", (req, res) => {
    counts[`${req.method} ${req.path}`] =
      (counts[`${req.method} ${req.path}`] || 0) + 1;
    const pending = orders.filter(
      (order) => order.status === "PENDING_PAYMENT_MANUAL",
    );
    const serialOrder = (order) => ({ ...order, payment: order.payments[0] });
    if (req.path === "/sales") {
      const to = salesDay(new Date());
      const start = new Date(`${to}T12:00:00Z`);
      start.setUTCDate(start.getUTCDate() - (req.query.period === "all" ? 35 : Number(req.query.period) || 30) + 1);
      const rows = [...orders, ...salesOrders].map((order) => ({ ...order, createdAt: new Date(order.createdAt) }));
      const receipts = new Map(rows.filter((order) => order.proofReceived).map((order) => [order.id, order.createdAt]));
      return res.json(buildSalesReport(rows, receipts, start.toISOString().slice(0, 10), to));
    }
    if (req.path === "/overview")
      return res.json({
        cards: {
          openConversations: 2,
          activeConversations: 2,
          messages24h: 86,
          failedMessages24h: 1,
          ordersToday: 4,
          pendingPayments: pending.length,
          paidOrders: orders.length - pending.length,
          paidRevenueCents: 6790,
        },
        pendingPaymentsQueue: pending.map(serialOrder),
        latestConversations: conversations,
        latestOrders: orders.map(serialOrder),
        attention: [],
      });
    if (req.path === "/orders") return res.json(orders.map(serialOrder));
    if (req.path === "/orders/pending-payments")
      return res.json(pending.map(serialOrder));
    const orderId = req.path.match(/^\/orders\/(order-demo-\d+)(?:\/(.*))?$/);
    if (orderId) {
      const order = [...orders, ...salesOrders].find((row) => row.id === orderId[1]);
      if (!order)
        return res.status(404).json({ message: "Pedido não encontrado." });
      if (orderId[2] === "confirm-payment" && req.method === "POST") {
        order.status = "PAID";
        order.payments[0].status = "PAID";
        order.payments[0].paidAt = now;
        return res.json({ notificationQueued: true });
      }
      if (orderId[2] === "status" && req.method === "PATCH")
        order.status = req.body.status;
      return res.json(order);
    }
    if (req.path === "/conversations") {
      const search = String(req.query.search || "").toLowerCase();
      return res.json(
        conversations.filter(
          (chat) =>
            (!search ||
              `${chat.customerName} ${chat.whatsappNumber}`
                .toLowerCase()
                .includes(search)) &&
            (!req.query.state || chat.pendingAction === req.query.state) &&
            (!req.query.status || chat.status === req.query.status),
        ),
      );
    }
    const chatId = req.path.match(
      /^\/conversations\/(chat\d)\/(messages|reset|close)$/,
    );
    if (chatId) {
      const chat = conversations.find((row) => row.id === chatId[1]);
      if (chatId[2] === "messages") {
        if (req.method === "POST")
          messages[chatId[1]].push({
            id: `m${Date.now()}`,
            direction: "OUTBOUND",
            status: "SENT",
            content: req.body.text,
            createdAt: now,
          });
        return res.json(messages[chatId[1]]);
      }
      if (chatId[2] === "close") chat.status = "CLOSED";
      else chat.pendingAction = "IDLE";
      return res.json({ success: true });
    }
    if (req.path === "/medicine-priorities") {
      if (req.method === "PUT") rules = req.body.rules;
      return res.json({ source: "database", rules });
    }
    if (req.path === "/provider-request-logs") return res.json(logs);
    if (req.path === "/providers")
      return res.json({
        database: { configured: true },
        whatsapp: { configured: true, apiVersion: "v25.0" },
        precoPopular: { enabled: true, priceMultiplier: 1 },
          medicines: {
            primaryProvider: "preco_popular",
            pharmadbConfigured: true,
            bulapiConfigured: true,
            backups: {
              pharmadb: { enabled: true, configured: true, pmcMultiplier: 0.5 },
              bulapi: { enabled: true, configured: true },
            },
        },
        retailProducts: { primaryProvider: "preco_popular", cosmosConfigured: false, cosmosTokenCount: 0 },
        payments: { directPixConfigured: true },
        admin: { protected: true },
      });
    if (req.path === "/attention") return res.json([]);
    if (req.path === "/database")
      return res.json({
        configured: true,
        connected: false,
        error: "Demonstração: nenhuma conexão real executada.",
      });
    if (req.path === "/errors")
      return res.json({
        summary: {
          failedMessages: 1,
          failedPayments: 0,
          pendingPayments: pending.length,
          cancelledOrders: 0,
        },
        failedMessages: [
          {
            customer: customers[0].name,
            content: "Mensagem fictícia para revisão",
            createdAt: now,
          },
        ],
        failedPayments: [],
      });
    return res.status(404).json({ message: "Rota ausente na demonstração." });
  });
  app.use("/admin", express.static(path.join(__dirname, "../public/admin")));
  app.get("/", (_req, res) => res.redirect("/admin/"));
  return { app, counts, messages, orders };
}

module.exports = { createAdminPreview };
if (require.main === module) {
  const { app } = createAdminPreview();
  const server = app.listen(
    Number(process.argv[2]) || 4190,
    "127.0.0.1",
    () => {
      console.log(
        `Admin demo (fictional data, no external calls): http://127.0.0.1:${server.address().port}/admin/`,
      );
    },
  );
  server.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
