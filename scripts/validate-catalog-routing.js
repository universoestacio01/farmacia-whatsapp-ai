const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Logger } = require("@nestjs/common");
const { Prisma, ConversationState } = require("@prisma/client");
const capture = require("./fixtures/first-aid-catalog-2026-09-23.json");
const { CommercialMedicineSelector } = require("../dist/integrations/commercial-medicine-selector");
const { BulaApiService } = require("../dist/integrations/bula-api.service");
const { PrecoPopularService } = require("../dist/integrations/preco-popular.service");
const { MedicineSearchOrchestratorService } = require("../dist/integrations/medicine-search-orchestrator.service");
const { ProductSearchOrchestratorService } = require("../dist/integrations/product-search-orchestrator.service");
const { ManualRetailProductService } = require("../dist/integrations/manual-retail-product.service");
const { ConversationEngineService } = require("../dist/whatsapp/conversation-engine.service");
const { normalizeRetailSearchQuery, matchesRetailQuery } = require("../dist/utils/retail-search-query.util");
const { formatProductDisplayName } = require("../dist/whatsapp/whatsapp-copy");
Logger.overrideLogger(false);
global.fetch = async () => assert.fail("External network forbidden");
const never = async () => assert.fail("Unexpected external side effect");

function harness(t, { query = "soro fisiologico", body, status = 200, error } = {}) {
  const calls = [];
  const rows = structuredClone(body ?? capture.requests.find((entry) => entry.query === query).body);
  t.mock.method(global, "fetch", async (url) => {
    calls.push(new URL(url));
    if (error) throw error;
    return new Response(JSON.stringify(rows), { status });
  });
  const selector = new CommercialMedicineSelector();
  const config = { get: () => undefined };
  const provider = new PrecoPopularService(config, selector);
  const metadata = new ManualRetailProductService();
  const retail = new ProductSearchOrchestratorService(metadata, provider);
  const medicines = new MedicineSearchOrchestratorService(selector, { findSymptomSuggestion: () => null }, { getRulesForPrinciple: async () => [] }, provider);
  const conversation = { id: "offline", customerId: "offline", pendingAction: ConversationState.IDLE, cart: [],
    lastIntent: null, currentMedicineQuery: null, currentRetailCategory: null, lastMedicine: null, selectedPresentation: null, candidateOptions: null };
  const prisma = { conversation: { update: async ({data}) => {
    for (const [key, value] of Object.entries(data)) conversation[key] = value === Prisma.JsonNull ? null : value;
    return conversation;
  } } };
  const engine = new ConversationEngineService(prisma, { generatePharmacyReply: never }, new BulaApiService(config, selector, {}), medicines,
    retail, { findAddressByCep: never }, { confirmCheckout: never });
  return { calls, rows, metadata, provider, medicines, retail, engine, conversation, send: (text) => engine.resolveReply(conversation, text) };
}

for (const entry of capture.requests) test(`captured HTTP ${entry.status}: ${entry.query} reaches retail options and cart`, async (t) => {
  const h = harness(t, { query: entry.query });
  const reply = await h.send(`Tem ${entry.query}?`);
  assert.doesNotMatch(reply, /Não localizei|marca de preferência/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].searchParams.get("ft"), entry.query);
  const options = h.conversation.candidateOptions;
  assert.ok(options.length > 0 && options.length <= 3);
  for (const option of options) {
    assert.equal(option.type, "retail_product");
    assert.equal(option.source, "preco_popular");
    const item = h.rows.flatMap((product) => product.items).find((item) => item.itemId === option.sourceId);
    assert.ok(item.sellers.some((seller) => seller.commertialOffer.Price === option.pricePf));
  }
  if (options.length > 1) await h.send("1");
  const selected = h.conversation.selectedPresentation;
  await h.send("2");
  assert.equal(h.conversation.cart[0].quantity, 2);
  assert.equal(h.conversation.cart[0].total, Math.round(selected.pricePf * 200) / 100);
});

for (const message of ["Tem soro fisiológico ?", "Soro fisiologico", "SORO FISIOLÓGICO", "Quero comprar soro fisiológico"]) {
  test(`screenshot variant: ${message}`, async (t) => {
    const h = harness(t);
    assert.doesNotMatch(await h.send(message), /Não localizei|dosagem/);
    assert.equal(h.conversation.candidateOptions.length, 3);
    assert.equal(h.calls[0].searchParams.get("ft"), "soro fisiologico");
  });
}

for (const message of ["Soro fisiologico 500ml", "Tem soro fisiologico 0,5L?"]) {
  test(`full requested volume is filtered against captured catalog: ${message}`, async (t) => {
    const h = harness(t);
    await h.send(message);
    assert.ok(h.conversation.candidateOptions.length);
    assert.ok(h.conversation.candidateOptions.every((option) => /500ml/.test(option.productName)));
  });
}

test("0,9% equals 0.9% without equating different concentrations or assuming missing metadata", async (t) => {
  const h = harness(t);
  await h.send("Soro fisiologico 0,9%");
  assert.equal(h.conversation.candidateOptions.length, 1);
  assert.match(h.conversation.selectedPresentation.productName, /0,9%/);
  assert.equal(normalizeRetailSearchQuery("soro fisiologico 0,9%"), "soro fisiologico 0.9%");
  assert.equal(matchesRetailQuery("soro fisiologico 9% 500ml", "soro fisiologico 0,9%", "soro fisiologico"), false);
  assert.equal(matchesRetailQuery("soro fisiologico 500ml", "soro fisiologico 0,9%", "soro fisiologico"), false);
});

test("unknown local product type uses catalog taxonomy, reusing the same HTTP response", async (t) => {
  const h = harness(t);
  t.mock.method(h.metadata, "isRetailProductQuery", () => false);
  const summary = await h.medicines.searchMedicine("soro fisiologico 500ml");
  assert.equal(summary.retailFallbackQuery, "soro fisiologico");
  await h.send("Tem soro fisiologico 500ml?");
  assert.equal(h.calls.length, 1, "taxonomy fallback must not spend another request");
  assert.equal(h.conversation.lastIntent, "RETAIL_PRODUCT");
  assert.ok(h.conversation.candidateOptions.every((option) => /500ml/.test(option.productName)));
});

test("a new category need not be hardcoded to return matching retail offers", async (t) => {
  const body = structuredClone(capture.requests[0].body.slice(0, 1));
  body[0].productName = body[0].items[0].name = "Curativo Transparente 10 Unidades";
  body[0].categories = ["/Primeiros Socorros/Curativos/"];
  const h = harness(t, { body });
  assert.equal(h.metadata.isRetailProductQuery("curativo transparente"), false);
  await h.send("Tem curativo transparente?");
  assert.equal(h.calls.length, 1);
  assert.equal(h.conversation.selectedPresentation.type, "retail_product");
  assert.match(h.conversation.selectedPresentation.productName, /Curativo/);
});

test("retail misses retain the requested volume instead of offering another package", async (t) => {
  const h = harness(t);
  assert.match(await h.send("Soro fisiologico 999ml"), /não está disponível para pedido/);
  assert.equal(h.conversation.selectedPresentation, null);
});

for (const status of [429, 500]) test(`HTTP ${status} is not reported as a missing product and is not retried`, async (t) => {
  const h = harness(t, { status });
  const reply = await h.send("Soro fisiologico");
  assert.match(reply, /Não consegui consultar/);
  assert.doesNotMatch(reply, /Não localizei/);
  assert.equal(h.calls.length, 1);
});

test("network failure remains an availability error, not a catalog miss", async (t) => {
  const h = harness(t, { error: new Error("offline") });
  assert.match(await h.send("Tem gaze?"), /Não consegui consultar/);
  assert.equal(h.calls.length, 1);
});

for (const reason of ["no_price", "out_of_stock"]) test(`retail ${reason} is different from a nonexistent product`, async (t) => {
  const body = structuredClone(capture.requests[0].body);
  for (const product of body) for (const item of product.items) for (const seller of item.sellers) {
    seller.commertialOffer[reason === "no_price" ? "Price" : "AvailableQuantity"] = 0;
  }
  const h = harness(t, { body });
  assert.match(await h.send("Soro fisiologico"), /não está disponível para pedido/);
  assert.equal(h.conversation.selectedPresentation, null);
});

test("medicine dosage mismatches cannot fall back to retail to bypass their restrictions", async (t) => {
  const body = structuredClone(capture.requests[0].body.slice(0, 1));
  body[0].productName = body[0].items[0].name = "Venvanse 30mg 28 Capsulas";
  body[0].categories = ["/Medicamentos/"];
  body[0]["Princípio Ativo"] = ["Lisdexanfetamina"];
  const h = harness(t, { body });
  const summary = await h.medicines.searchMedicine("venvanse 70mg");
  assert.equal(summary.retailFallbackQuery, undefined);
  assert.equal(summary.searchStatus, "presentation_not_found");
  assert.equal(summary.options.length, 0);
});

test("injectable catalog item can follow the retail route when the catalog classifies it there", async (t) => {
  const body = structuredClone(capture.requests[0].body.slice(0, 1));
  body[0].productName = body[0].items[0].name = "Soro Fisiologico Injetavel 500ml";
  const h = harness(t, { body });
  await h.send("Soro fisiologico");
  assert.ok(h.conversation.selectedPresentation);
  assert.match(h.conversation.selectedPresentation.productName, /Injet/);
  assert.ok(h.conversation.selectedPresentation.pricePf > 0);
});

test("sem alcool is a qualifier, never an instruction to search alcohol", () => {
  const metadata = new ManualRetailProductService();
  assert.equal(metadata.findCatalogKey("desodorante sem alcool"), "desodorante");
  assert.equal(metadata.isRetailProductQuery("xarope sem alcool"), false);
});

test("first-aid labels have accents while retaining volume and concentration", () => {
  assert.equal(formatProductDisplayName("Soro Fisiologico 0,9% 500ml"), "Soro Fisiológico 0,9% 500ml");
  assert.equal(formatProductDisplayName("Alcool 70% 50ml"), "Álcool 70% 50ml");
  assert.equal(formatProductDisplayName("Termometro Digital"), "Termômetro Digital");
});
