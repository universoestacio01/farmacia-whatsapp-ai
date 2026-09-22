const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Logger } = require("@nestjs/common");
const { ConversationState, Prisma } = require("@prisma/client");
const { BulaApiService } = require("../dist/integrations/bula-api.service");
const {
  CommercialMedicineSelector,
} = require("../dist/integrations/commercial-medicine-selector");
const {
  ManualRetailProductService,
} = require("../dist/integrations/manual-retail-product.service");
const {
  ProductSearchOrchestratorService,
} = require("../dist/integrations/product-search-orchestrator.service");
const {
  ConversationEngineService,
} = require("../dist/whatsapp/conversation-engine.service");
const {
  getConversationOpeningIntent,
} = require("../dist/utils/conversation-opening.util");

Logger.overrideLogger(false);
global.fetch = async () => {
  throw new Error("External API calls are forbidden in this suite");
};
const never = async () => {
  assert.fail("Unexpected external service or AI call");
};
const config = { get: () => undefined };
const selector = new CommercialMedicineSelector();
const bula = new BulaApiService(config, selector, {
  getRulesForPrinciple: async () => [],
});

function createFixture(state = ConversationState.IDLE, overrides = {}) {
  const conversation = {
    id: "offline-chat",
    customerId: "offline-customer",
    pendingAction: state,
    lastIntent: null,
    lastMedicine: null,
    currentMedicineQuery: null,
    currentRetailCategory: null,
    candidateOptions: null,
    selectedPresentation: null,
    cart: [],
    pendingAddress: null,
    ...structuredClone(overrides),
  };
  const queries = { medicines: [], retail: [] };
  const updates = [];
  const prisma = {
    conversation: {
      update: async ({ data }) => {
        updates.push(data);
        for (const [key, value] of Object.entries(data))
          conversation[key] = value === Prisma.JsonNull ? null : value;
        return conversation;
      },
    },
  };
  const products = new ProductSearchOrchestratorService(
    { search: never, findByGtin: never },
    new ManualRetailProductService(),
  );
  products.searchProducts = async (query) => {
    queries.retail.push(query);
    return { query, options: [], manualFallback: false };
  };
  const medicineSearch = {
    findSymptomSuggestion: () => null,
    searchMedicine: async (query) => {
      queries.medicines.push(query);
      const parsed = selector.parseMedicineQuery(query);
      return {
        medicineName: parsed.medicineName,
        products: [],
        options: [1, 2, 3].map((id) => ({
          optionId: id,
          productId: id,
          presentationId: id,
          type: "medicine",
          source: "preco_popular",
          medicineName: parsed.medicineName,
          productName: parsed.medicineName,
          label: `${parsed.medicineName} ${parsed.dosage || "500mg"} caixa ${id * 10}`,
          formGroup: "comprimido",
          strength: parsed.dosage || "500mg",
          pricePf: 9,
          packageDescription: `caixa com ${id * 10} comprimidos`,
        })),
      };
    },
  };
  const engine = new ConversationEngineService(
    prisma,
    { generatePharmacyReply: never },
    bula,
    medicineSearch,
    products,
    { findAddressByCep: never },
    { confirmCheckout: never },
  );
  return {
    conversation,
    queries,
    updates,
    send: (text) => engine.resolveReply(conversation, text),
  };
}

const openings = [
  "Olá, Gostaria de fazer um pedido",
  "Olá, gostaria de fazer um pedido!",
  "  OLÁ,  GOSTARIA DE FAZER UM PEDIDO.  ",
  "Ola gostaria de fazer um pedido",
  "Gostaria de fazer um pedido",
  "Quero fazer um pedido",
  "Bom dia! Quero comprar",
  "Boa tarde, queria fazer uma compra",
  "Oi, tudo bem? Posso fazer um pedido?",
  "Olá! Quero fazer um pedido por favor",
  "Queria comprar",
  "Preciso fazer uma compra",
  "Tem como fazer um pedido?",
  "Dá para fazer um pedido?",
  "Eu gostaria de realizar um pedido",
  "Gostaria de fazer um novo pedido",
  "Fazer pedido",
  "Pedido",
  "Quero um remédio",
  "Quero comprar um medicamento",
  "Gostaria de fazer um pedido pelo WhatsApp",
];

for (const text of openings) {
  test(`opening without product asks for an item without any lookup: ${text}`, async () => {
    assert.equal(getConversationOpeningIntent(text), "start_order");
    assert.equal(bula.detectMedicineQuestion(text), null);
    assert.equal(bula.extractMedicineName(text), null);
    const fixture = createFixture();
    const reply = await fixture.send(text);
    assert.match(reply, /Raia Delivery/);
    assert.match(reply, /Qual medicamento ou produto você precisa/);
    assert.doesNotMatch(reply, /Não localizei|foto|embalagem|unidades/);
    assert.equal(
      fixture.conversation.pendingAction,
      ConversationState.WAITING_MEDICINE_NAME,
    );
    assert.equal(fixture.conversation.currentMedicineQuery, null);
    assert.deepEqual(fixture.queries, { medicines: [], retail: [] });
  });
}

for (const text of [
  "Olá!",
  "Oi, tudo bem?",
  "Bom dia!!!",
  "Boa tarde.",
  "Boa noite!",
  "Olá 👋",
  "Tudo bem?",
]) {
  test(`greetings with punctuation do not reach search: ${text}`, async () => {
    const fixture = createFixture(ConversationState.WAITING_QUANTITY);
    const reply = await fixture.send(text);
    assert.match(reply, /Raia Delivery/);
    assert.equal(bula.detectMedicineQuestion(text), null);
    assert.deepEqual(fixture.queries, { medicines: [], retail: [] });
  });
}

for (const state of Object.values(ConversationState).filter(
  (value) => value !== ConversationState.WAITING_PIX,
)) {
  test(`order opening safely exits stale ${state} without clearing cart/address`, async () => {
    const cart = [
      {
        type: "medicine",
        name: "Dipirona",
        medicineName: "dipirona",
        form: "comprimido",
        quantity: 1,
        unitPrice: 9,
        total: 9,
      },
    ];
    const address = { cep: "00000000", number: "1" };
    const fixture = createFixture(state, {
      cart,
      pendingAddress: address,
      currentMedicineQuery: "produto antigo",
      currentRetailCategory: "shampoo",
      candidateOptions: [{ optionId: 1 }],
      selectedPresentation: { label: "antigo" },
      lastIntent: "WAITING_REMOVE_ITEM",
    });
    const reply = await fixture.send(openings[0]);
    assert.match(reply, /carrinho continua salvo/);
    assert.deepEqual(fixture.conversation.cart, cart);
    assert.deepEqual(fixture.conversation.pendingAddress, address);
    assert.equal(fixture.conversation.candidateOptions, null);
    assert.equal(fixture.conversation.selectedPresentation, null);
    assert.equal(fixture.conversation.lastIntent, "START_ORDER");
    assert.equal(
      fixture.conversation.pendingAction,
      ConversationState.WAITING_MEDICINE_NAME,
    );
    assert.deepEqual(fixture.queries, { medicines: [], retail: [] });
  });
}

test("pending Pix remains pending: opening does not reset or create a new payment", async () => {
  const fixture = createFixture(ConversationState.WAITING_PIX);
  const reply = await fixture.send(openings[0]);
  assert.match(reply, /comprovante/i);
  assert.equal(
    fixture.conversation.pendingAction,
    ConversationState.WAITING_PIX,
  );
  assert.deepEqual(fixture.updates, []);
  assert.deepEqual(fixture.queries, { medicines: [], retail: [] });
});

for (const [text, name, dose] of [
  ["Olá, quero dipirona 1g", "dipirona", 1000],
  ["Olá, gostaria de comprar dipirona 0,5g", "dipirona", 500],
  ["Bom dia! Quero dipirona 0.5g", "dipirona", 500],
  ["Olá, quero fazer um pedido de dipirona 1g", "dipirona", 1000],
  ["Boa noite, tem Venvanse de 50mg?", "venvanse", 50],
  ["Olá, gostaria de comprar bisoprolol 5mg", "bisoprolol", 5],
  ["Oi! Tem Dorflex?", "dorflex", undefined],
]) {
  test(`greeting with named product preserves search and dosage: ${text}`, async () => {
    assert.equal(getConversationOpeningIntent(text), null);
    const fixture = createFixture();
    const reply = await fixture.send(text);
    assert.equal(fixture.queries.medicines.length, 1);
    assert.equal(fixture.queries.retail.length, 0);
    const parsed = selector.parseMedicineQuery(fixture.queries.medicines[0]);
    assert.equal(parsed.medicineName, name);
    assert.equal(parsed.dosageMg, dose);
    assert.match(reply.toLowerCase(), new RegExp(name));
    assert.equal(
      fixture.conversation.pendingAction,
      ConversationState.WAITING_PRESENTATION,
    );
  });
}

test("greeting with retail product still uses retail, not medicine", async () => {
  const fixture = createFixture();
  assert.equal(
    getConversationOpeningIntent("Olá, gostaria de comprar sabonete Dove"),
    null,
  );
  await fixture.send("Olá, gostaria de comprar sabonete Dove");
  assert.equal(fixture.queries.retail.length, 1);
  assert.equal(fixture.queries.medicines.length, 0);
});

test("real opening -> medicine -> selection -> quantity adds item to cart", async () => {
  const fixture = createFixture();
  await fixture.send(openings[0]);
  const reply = await fixture.send("Tem dipirona 1g?");
  assert.match(reply.toLowerCase(), /dipirona/);
  await fixture.send("1");
  assert.equal(
    fixture.conversation.pendingAction,
    ConversationState.WAITING_QUANTITY,
  );
  await fixture.send("2");
  assert.equal(fixture.conversation.cart.length, 1);
  assert.equal(fixture.conversation.cart[0].quantity, 2);
  assert.equal(fixture.conversation.cart[0].unitPrice, 9);
  assert.equal(fixture.conversation.cart[0].total, 18);
});

test("checkout commands, specific products and symptoms are not generic openings", () => {
  for (const text of [
    "finalizar",
    "ver carrinho",
    "paguei",
    "cancelar",
    "remover item 1",
    "Tem dipirona?",
    "Quero remédio para dor de cabeça",
    "Olá, quero remédio para dor de barriga",
    "Quero comprar 2 sabonetes Dove",
    "Quero pedido com Venvanse 70mg",
  ]) {
    assert.equal(getConversationOpeningIntent(text), null, text);
  }
});
