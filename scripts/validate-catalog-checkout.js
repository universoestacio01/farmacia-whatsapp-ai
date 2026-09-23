const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Logger } = require("@nestjs/common");
const { ConversationState: State, Prisma } = require("@prisma/client");
const { ConversationEngineService } = require("../dist/whatsapp/conversation-engine.service");
const { ConversationInputService } = require("../dist/whatsapp/conversation-input.service");
const { BulaApiService } = require("../dist/integrations/bula-api.service");
const { CommercialMedicineSelector } = require("../dist/integrations/commercial-medicine-selector");
const { ViaCepService } = require("../dist/integrations/via-cep.service");
const { PaymentsService } = require("../dist/payments/payments.service");
const { PrecoPopularService } = require("../dist/integrations/preco-popular.service");
const { missingAddressField } = require("../dist/whatsapp/delivery-address");
const { CATALOG_PRICE_POLICY } = require("../dist/config/preco-popular.config");

Logger.overrideLogger(false);
const never = async () => assert.fail("Unexpected external dependency");
global.fetch = never;
const config = { get: () => undefined };
const selector = new CommercialMedicineSelector();
const completeAddress = {
  cep: "88301080", logradouro: "Rua Olimpio Miranda Junior", bairro: "Centro",
  localidade: "Itajai", uf: "SC", complemento: "", number: "168",
};
const cart = [
  { type: "medicine", name: "Dipirona 1g", medicineName: "dipirona", quantity: 2, unitPrice: 21.9, total: 43.8,
    source: "preco_popular", sourceId: "10", ean: "7890000000010", pricePolicy: CATALOG_PRICE_POLICY },
  { type: "retail_product", name: "Sabonete Dove 90g", quantity: 1, unitPrice: 5.19, total: 5.19,
    source: "preco_popular", sourceId: "11", ean: "7890000000011", pricePolicy: CATALOG_PRICE_POLICY },
];

function fixture({ lookup = async (cep) => ({ ...completeAddress, number: undefined, cep }), overrides = {}, offer = never } = {}) {
  const conversation = {
    id: "offline-conversation", customerId: "offline-customer",
    pendingAction: State.WAITING_CEP, lastIntent: null, lastMedicine: null,
    currentMedicineQuery: null, currentRetailCategory: null, selectedPresentation: null,
    candidateOptions: [], cart: structuredClone(cart), pendingAddress: null,
    ...structuredClone(overrides),
  };
  const checkouts = [];
  const cepCalls = [];
  const updates = [];
  const prisma = {
    conversation: { update: async ({ data }) => {
      updates.push(data);
      for (const [key, value] of Object.entries(data)) conversation[key] = value === Prisma.JsonNull ? null : value;
      return conversation;
    } },
  };
  const engine = new ConversationEngineService(
    prisma, { generatePharmacyReply: never }, new BulaApiService(config, selector, {}),
    { searchMedicine: never, findSymptomSuggestion: () => null },
    { isRetailProductQuery: () => false },
    { findAddressByCep: async (cep) => { cepCalls.push(cep); return lookup(cep); } },
    { confirmCheckout: async (input) => {
      checkouts.push(input);
      return { orderId: "offline-order", totalCents: Math.round(input.cart.reduce((sum, item) => sum + item.total, 0) * 100),
        pixCopyPaste: "OFFLINE-PIX", status: "pending" };
    } },
    new ConversationInputService(), { findCurrentOffer: offer },
  );
  return { conversation, checkouts, cepCalls, updates, send: (text) => engine.resolveReply(conversation, text) };
}

test("generic CEP 23860-000 collects street and neighborhood before number and Pix", async () => {
  const f = fixture({ lookup: async (cep) => ({
    cep, logradouro: "", bairro: "", localidade: "Mangaratiba", uf: "RJ", complemento: "",
  }) });
  assert.match(await f.send("23860-000"), /nome da rua/);
  assert.equal(f.conversation.pendingAction, State.WAITING_ADDRESS_NUMBER);
  assert.match(await f.send("10"), /nome da rua/);
  assert.match(await f.send("Rua 1 de Maio"), /bairro/);
  assert.match(await f.send("Centro"), /número/);
  assert.match(await f.send("10"), /complemento/);
  const summary = await f.send("Casa 2");
  assert.match(summary, /Rua 1 de Maio/);
  assert.match(summary, /Centro, Mangaratiba\/RJ/);
  assert.match(summary, /Casa 2/);
  assert.doesNotMatch(summary, /: ,|, ,/);
  assert.equal(f.checkouts.length, 0);
  await f.send("1");
  assert.equal(f.checkouts.length, 1);
  assert.equal(missingAddressField(f.checkouts[0].address), null);
  assert.equal(f.checkouts[0].cart.length, 2);
  assert.equal(f.cepCalls.length, 1);
});

test("lookup failure allows complete manual address including city/state and no number", async () => {
  const f = fixture({ lookup: async () => null });
  assert.match(await f.send("23860000"), /preenchendo o endereço/);
  assert.match(await f.send("Estrada do Sertão"), /bairro/);
  assert.match(await f.send("Zona Rural"), /cidade/);
  assert.match(await f.send("Mangaratiba"), /sigla do estado/);
  assert.match(await f.send("ZZ"), /sigla do estado/);
  assert.match(await f.send("rj"), /número/);
  assert.match(await f.send("s/n"), /complemento/);
  const summary = await f.send("Próximo ao mercado");
  assert.match(summary, /Estrada do Sertão, número s\/n/);
  assert.match(summary, /Zona Rural, Mangaratiba\/RJ/);
  assert.match(summary, /Referência/);
  await f.send("1");
  assert.equal(f.checkouts.length, 1);
});

test("complete CEP retains existing number/complement/confirmation flow", async () => {
  const f = fixture();
  const reply = await f.send("88301-080");
  assert.match(reply, /Rua Olimpio Miranda Junior/);
  assert.match(reply, /número/);
  assert.match(await f.send("168"), /complemento/);
  assert.match(await f.send("não"), /Resumo do pedido/);
  await f.send("confirmar");
  assert.equal(f.checkouts.length, 1);
  assert.equal(f.checkouts[0].address.number, "168");
});

for (const value of ["23860", "238600000", "abcdefgh", "00000000", "abc23860000", "23860-00"]) {
  test(`invalid CEP ${value} never queries provider or advances`, async () => {
    const f = fixture();
    assert.match(await f.send(value), /CEP/);
    assert.equal(f.cepCalls.length, 0);
    assert.equal(f.conversation.pendingAction, State.WAITING_CEP);
  });
}

test("only missing fields are requested, retaining known street/city/state", async () => {
  const f = fixture({ lookup: async () => ({ ...completeAddress, number: undefined, bairro: "" }) });
  assert.match(await f.send("88301080"), /bairro/);
  assert.match(await f.send("Centro"), /número/);
});

for (const state of [State.WAITING_ADDRESS_COMPLEMENT, State.WAITING_CONFIRMATION]) {
  test(`legacy incomplete address in ${state} cannot skip street`, async () => {
    const f = fixture({ overrides: { pendingAction: state, pendingAddress: { ...completeAddress, logradouro: "" } } });
    assert.match(await f.send(state === State.WAITING_CONFIRMATION ? "1" : "Casa 2"), /nome da rua/);
    assert.equal(f.checkouts.length, 0);
    assert.equal(f.conversation.pendingAction, State.WAITING_ADDRESS_NUMBER);
  });
}

for (const field of ["cep", "logradouro", "bairro", "localidade", "uf", "number"]) {
  test(`payment service rejects missing ${field} before any database/payment call`, async () => {
    const service = new PaymentsService({}, {}, { createPayment: never });
    await assert.rejects(service.confirmCheckout({
      conversationId: "offline", customerId: "offline", cart,
      address: { ...completeAddress, [field]: "" },
    }), /Endereço de entrega incompleto/);
  });
}

test("global cart/back/add-more/cancel/reset commands remain available during manual address", async () => {
  const f = fixture({ lookup: async () => null });
  await f.send("23860000");
  assert.match(await f.send("ver carrinho"), /Seu carrinho/);
  assert.equal(f.conversation.pendingAction, State.WAITING_ADDRESS_NUMBER);
  assert.match(await f.send("voltar"), /CEP/);
  await f.send("23860000");
  assert.match(await f.send("adicionar mais"), /produto/);
  assert.equal(f.conversation.cart.length, 2);
  await f.send("finalizar");
  await f.send("23860000");
  assert.match(await f.send("cancelar"), /limpar/);
  assert.equal(f.checkouts.length, 0);
  await f.send("reset");
  assert.equal(f.checkouts.length, 0);
});

test("old discounted cart is repriced and requires a new confirmation before payment", async () => {
  const oldCart = structuredClone(cart);
  oldCart[0].pricePolicy = undefined;
  oldCart[0].unitPrice = 19.71;
  oldCart[0].total = 39.42;
  let lookups = 0;
  const f = fixture({ overrides: { pendingAction: State.WAITING_CONFIRMATION, pendingAddress: completeAddress, cart: oldCart },
    offer: async (item) => { lookups++; return { source: "preco_popular", sourceId: item.sourceId, ean: item.ean, price: 21.9 }; } });
  assert.match(await f.send("1"), /Atualizei os valores/);
  assert.equal(f.checkouts.length, 0);
  assert.equal(f.conversation.cart[0].total, 43.8);
  await f.send("1");
  assert.equal(f.checkouts.length, 1);
  assert.equal(lookups, 1);
  assert.equal(f.checkouts[0].cart[0].unitPrice, 21.9);
});

test("unidentifiable legacy item cannot keep an invented or discounted price", async () => {
  const oldCart = [{ ...cart[0], source: "popular_manual", pricePolicy: undefined, ean: undefined, sourceId: undefined }];
  const f = fixture({ overrides: { cart: oldCart, pendingAction: State.WAITING_CONFIRMATION, pendingAddress: completeAddress }, offer: async () => null });
  assert.match(await f.send("1"), /remover item 1/);
  assert.equal(f.checkouts.length, 0);
  assert.equal(f.conversation.cart.length, 1);
});

test("already issued order/Pix retries do not change agreed prices", async () => {
  const oldCart = [{ ...cart[0], pricePolicy: undefined, unitPrice: 19.71, total: 39.42 }];
  const f = fixture({ overrides: { cart: oldCart, pendingAction: State.WAITING_PIX, lastIntent: "ORDER_CONFIRMED:old-order", pendingAddress: completeAddress } });
  await f.send("1");
  assert.equal(f.checkouts.length, 1);
  assert.equal(f.checkouts[0].cart[0].unitPrice, 19.71);
  assert.equal(f.checkouts[0].existingOrderId, "old-order");
});

test("ViaCEP unexpected JSON, not found and HTTP failures return null for manual entry", async (t) => {
  const service = new ViaCepService(config);
  for (const [body, status] of [[{ erro: true }, 200], [{ erro: "true" }, 200], [null, 200], [[], 200], [{ localidade: "Teste", uf: 12 }, 200], [{}, 500]]) {
    const mocked = t.mock.method(global, "fetch", async () => new Response(JSON.stringify(body), { status }));
    assert.equal(await service.findAddressByCep("23860000"), null);
    mocked.mock.restore();
  }
});

test("ViaCEP timeout is bounded and failure returns null", async (t) => {
  t.mock.method(AbortSignal, "timeout", (ms) => {
    assert.equal(ms, 5000);
    return AbortSignal.abort(new Error("offline timeout"));
  });
  t.mock.method(global, "fetch", async (_url, init) => { init.signal.throwIfAborted(); });
  assert.equal(await new ViaCepService(config).findAddressByCep("23860000"), null);
});

test("legacy cart refresh uses exact EAN, rejecting a different product", async (t) => {
  t.mock.method(global, "fetch", async (url) => {
    assert.equal(new URL(url).searchParams.get("fq"), "alternateIds_Ean:7890000000010");
    return new Response(JSON.stringify([{
      productId: "20", productName: "Outro produto", items: [{ itemId: "20", ean: "7890000000020",
        sellers: [{ commertialOffer: { Price: 10 } }] }],
    }]));
  });
  const service = new PrecoPopularService(config, selector);
  assert.equal(await service.findCurrentOffer(cart[0]), null);
});
