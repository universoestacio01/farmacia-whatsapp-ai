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

function createFixture(state = ConversationState.IDLE, overrides = {}, lookupStatus) {
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
    new ManualRetailProductService(),
    { isEnabled: () => true, searchRetail: never, findRetailByGtin: never },
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
      if (lookupStatus) return { medicineName: parsed.medicineName, products: [], options: [], searchStatus: lookupStatus };
      return {
        medicineName: parsed.medicineName,
        products: [],
        options: [1, 2, 3].map((id) => ({
          optionId: id,
          productId: id,
          presentationId: id,
          type: "medicine",
          source: "preco_popular",
          pricePolicy: "preco_popular_full_v1",
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

for (const status of ["backup_unavailable", "unavailable", "incomplete", "attributes_unverified", "restricted"]) {
  test(`sales recovery for ${status} offers a real next step without technical language`, async () => {
    const f = createFixture(ConversationState.IDLE, {}, status);
    const reply = await f.send("Tem neosulida?");
    assert.match(reply, /buscar outro produto/);
    assert.doesNotMatch(reply, /equipe|atendimento|conferência/i);
    assert.doesNotMatch(reply, /fontes|catálogo|API|OpenAI|consulta principal|em falta|Pode conferir o nome/i);
    assert.ok(reply.length < 230);
    assert.equal(f.conversation.lastIntent, "CATALOG_UNAVAILABLE");
    assert.equal(f.conversation.selectedPresentation, null);
  });
}

test("technical failures keep cart and permit an explicit automated retry", async () => {
  const cart = [{ name: "Item existente", quantity: 1, unitPrice: 10 }];
  const f = createFixture(ConversationState.IDLE, { cart }, "backup_unavailable");
  await f.send("Tem neosulida?");
  assert.notEqual(f.conversation.lastIntent, "CATALOG_REVIEW_REQUESTED");
  assert.match(await f.send("tentar novamente"), /Não consegui consultar/);
  assert.equal(f.conversation.lastIntent, "CATALOG_UNAVAILABLE");
  assert.equal(f.queries.medicines.length, 2);
  assert.deepEqual(f.conversation.cart, cart);
});

test("recovery accepts another product or a new query without interpreting 1 as a cart item", async () => {
  const f = createFixture(ConversationState.IDLE, {}, "backup_unavailable");
  await f.send("Tem neosulida?");
  assert.match(await f.send("sim"), /Qual produto/);
  assert.equal(f.conversation.lastIntent, "ADD_ITEM");
  await f.send("Dramin");
  assert.match(f.queries.medicines[1], /dramin/i);
  assert.equal(f.conversation.cart.length, 0);
});

for (const text of ["Não, obrigada", "Não, obrigado!", "Não. Obrigada."]) {
  test(`declining another product is not a catalog query: ${text}`, async () => {
    const f = createFixture(ConversationState.WAITING_MEDICINE_NAME, {
      lastIntent: "CATALOG_UNAVAILABLE", currentMedicineQuery: "fiber biome",
      cart: [{name: "Item", quantity: 1, unitPrice: 10}],
    });
    assert.match(await f.send(text), /Tudo bem/);
    assert.equal(f.queries.medicines.length, 0);
    assert.equal(f.queries.retail.length, 0);
    assert.equal(f.conversation.cart.length, 1);
  });
}

for (const intent of ["CATALOG_HELP_OPTIONS", "CATALOG_REVIEW_REQUESTED", "CATALOG_REVIEW_HANDLED"]) {
  test(`retired ${intent} resumes automatically and preserves cart`, async () => {
    const cart = [{ name: "Sabonete", quantity: 1, unitPrice: 5 }];
    const f = createFixture(ConversationState.WAITING_MEDICINE_NAME, { cart, lastIntent: intent, currentMedicineQuery: "ozempic" }, "restricted");
    const reply = await f.send("1");
    assert.match(f.queries.medicines[0], /ozempic/i);
    assert.match(reply, /não está disponível para pedido/);
    assert.doesNotMatch(reply, /equipe|atendimento|registrada/);
    assert.equal(f.conversation.lastIntent, "CATALOG_UNAVAILABLE");
    assert.deepEqual(f.conversation.cart, cart);
    await f.send("Dramin");
    assert.match(f.queries.medicines[1], /dramin/i);
  });
}

for (const status of ["not_found", "search_unverified", "offer_unavailable"]) {
  test(`no sellable product (${status}) asks for another product without human menu or stock claim`, async () => {
    const cart = [{ name: "Sabonete", quantity: 1, unitPrice: 5 }];
    const f = createFixture(ConversationState.IDLE, { cart }, status);
    const reply = await f.send("Tem neosulida?");
    assert.match(reply, /não está disponível para pedido/);
    assert.match(reply, /gostaria de buscar outro produto/);
    assert.doesNotMatch(reply, /equipe|Solicitar atendimento|fontes|catálogo|em falta|foto/);
    assert.equal(f.conversation.lastIntent, "CATALOG_UNAVAILABLE");
    assert.equal(f.conversation.selectedPresentation, null);
    assert.match(await f.send("não"), /Tudo bem/);
    assert.deepEqual(f.conversation.cart, cart);
    assert.match(await f.send("sim"), /Qual produto/);
    assert.equal(f.conversation.currentMedicineQuery, null);
    await f.send("Tem Dramin?");
    assert.match(f.queries.medicines[1], /dramin/i);
    assert.deepEqual(f.conversation.cart, cart);
  });
}

test("another product can be entered directly after unavailable response", async () => {
  const f = createFixture(ConversationState.IDLE, {}, "not_found");
  await f.send("Tem neosulida?");
  await f.send("Tem dipirona 1g?");
  assert.match(f.queries.medicines[1], /dipirona.*1\s*g/);
  assert.equal(f.conversation.cart.length, 0);
});

test("dranim requires confirmation before any medicine lookup; preserves dosage and cart", async () => {
  const f = createFixture();
  const reply = await f.send("Tem dranim de 50mg?");
  assert.match(reply, /Você quis dizer Dramin/);
  assert.equal(f.queries.medicines.length, 0);
  assert.equal(f.conversation.lastIntent, "WAITING_MEDICINE_SPELLING_CONFIRMATION");
  assert.match(await f.send("3"), /Confirme o nome/);
  assert.equal(f.queries.medicines.length, 0);
  await f.send("sim");
  assert.equal(f.queries.medicines.length, 1);
  assert.match(f.queries.medicines[0].toLowerCase(), /dramin.*50\s?mg/);
  assert.equal(f.conversation.cart.length, 0);
});

test("declining a spelling suggestion does not search or substitute", async () => {
  const f = createFixture();
  await f.send("Tem dranim?");
  assert.match(await f.send("2"), /Não vou trocar/);
  assert.equal(f.queries.medicines.length, 0);
  assert.equal(f.conversation.candidateOptions, null);
  await f.send("Tem neosulida?");
  assert.match(f.queries.medicines[0], /neosulida/i);
});

test("actual production spelling dramim asks confirmation and avoids wasted fallback calls", async () => {
  const f = createFixture();
  assert.match(await f.send("Tem dramim?"), /Você quis dizer Dramin/);
  assert.equal(f.queries.medicines.length, 0);
  await f.send("1");
  assert.match(f.queries.medicines[0], /dramin/i);
});

test("new product overrides pending spelling confirmation; exact Dramin needs no correction", async () => {
  const f = createFixture();
  await f.send("dranim");
  await f.send("dipirona 1g");
  assert.match(f.queries.medicines[0], /dipirona/);
  const other = createFixture();
  await other.send("Tem Dramin?");
  assert.equal(other.queries.medicines.length, 1);
  assert.notEqual(other.conversation.lastIntent, "WAITING_MEDICINE_SPELLING_CONFIRMATION");
});

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
