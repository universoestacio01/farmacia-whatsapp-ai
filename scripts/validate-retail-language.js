const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Logger } = require("@nestjs/common");
const { Prisma, ConversationState } = require("@prisma/client");
const { RETAIL_SEARCH_ALIASES } = require("../dist/config/retail-search-aliases.config");
const { normalizeRetailSearchQuery, normalizeRetailTerms, extractRetailGtin, matchesRetailQuery } = require("../dist/utils/retail-search-query.util");
const { ManualRetailProductService } = require("../dist/integrations/manual-retail-product.service");
const { ProductSearchOrchestratorService } = require("../dist/integrations/product-search-orchestrator.service");
const { PrecoPopularService } = require("../dist/integrations/preco-popular.service");
const { CommercialMedicineSelector } = require("../dist/integrations/commercial-medicine-selector");
const { BulaApiService } = require("../dist/integrations/bula-api.service");
const { ConversationEngineService } = require("../dist/whatsapp/conversation-engine.service");
const { WhatsappCopy } = require("../dist/whatsapp/whatsapp-copy");

Logger.overrideLogger(false);
global.fetch = async () => assert.fail("External network forbidden");
const never = async () => assert.fail("Unexpected database/payment/AI/medicine call");
const config = { get: () => undefined };
const manual = new ManualRetailProductService();

// Synthetic contract fixtures, not a claim about live prices or stock.
const catalog = [
  ["Aparelho Gillette Fusion 5", "Gillette", "Barbear", 43.89],
  ["Aparelho Gillette Mach3 Regular", "Gillette", "Barbear", 32.9],
  ["Aparelho Gillette Mach3 Sensitive", "Gillette", "Barbear", 37.59],
  ["Refil Gillette Mach3 4 Unidades", "Gillette", "Barbear", 44.9],
  ["Cotonetes Johnsons Pote 150 Unidades", "Johnson's", "Higiene", 15.5],
  ["Cotonetes Johnsons 75 Unidades", "Johnson's", "Higiene", 8.9],
  ["Shampoo Seda 325ml", "Seda", "Cabelos", 18.75],
  ["Shampoo Seda 200ml", "Seda", "Cabelos", 13.9],
  ["Shampoo Pantene 400ml", "Pantene", "Cabelos", 23.9],
  ["Escova Dental Oral-B Macia", "Oral-B", "Higiene Bucal", 8.9],
  ["Creme Dental Oral-B 70g", "Oral-B", "Higiene Bucal", 9.9],
  ["Creme Dental Colgate 90g", "Colgate", "Higiene Bucal", 5.19],
  ["Fio Dental Oral-B 50m", "Oral-B", "Higiene Bucal", 10.9],
  ["Lenços Umedecidos Huggies 48 Unidades", "Huggies", "Bebe", 12.9],
  ["Fraldas Huggies M 48 Unidades", "Huggies", "Bebe", 29.9],
  ["Fraldas Pampers G 30 Unidades", "Pampers", "Bebe", 30.9],
  ["Fraldas Pampers M 30 Unidades", "Pampers", "Bebe", 27.9],
  ["Protetor Solar Nivea FPS 30 50ml", "Nivea", "Cuidados", 36.9],
  ["Protetor Solar Nivea FPS 50 50ml", "Nivea", "Cuidados", 42.9],
  ["Desodorante Rexona Roll-on Sem Alcool 50ml", "Rexona", "Higiene", 13.9],
  ["Desodorante Rexona Aerosol 150ml", "Rexona", "Higiene", 17.9],
  ["Preservativos Jontex 3 Unidades", "Jontex", "Higiene", 9.9],
  ["Condicionador Tresemme 400ml", "Tresemme", "Cabelos", 24.9],
  ["Sabonete Liquido Dove 250ml", "Dove", "Higiene", 12.9],
  ["Kit Shampoo Seda + Condicionador 325ml", "Seda", "Cabelos", 29.9],
].map(([name, brand, category, price], index) => ({
  productId: String(index + 1), productName: name, brand, categories: [`/Higiene/${category}/`],
  items: [{ itemId: String(index + 1), name, ean: `789123456${String(index).padStart(4, "0")}`,
    images: [{ imageUrl: "https://example.com/product.jpg" }],
    sellers: [{sellerDefault: true, commertialOffer: {Price: price, AvailableQuantity: 10}}] }],
}));

function harness(t, records = catalog) {
  const calls = [];
  t.mock.method(global, "fetch", async (url) => {
    calls.push(new URL(url));
    return new Response(JSON.stringify(records), { status: 200 });
  });
  const selector = new CommercialMedicineSelector();
  const provider = new PrecoPopularService(config, selector);
  const search = new ProductSearchOrchestratorService(manual, provider);
  const conversation = { id: "offline", customerId: "offline", pendingAction: ConversationState.IDLE,
    lastIntent: null, lastMedicine: null, currentMedicineQuery: null, currentRetailCategory: null,
    candidateOptions: null, selectedPresentation: null, cart: [], pendingAddress: null };
  const prisma = { conversation: { update: async ({data}) => {
    for (const [key, value] of Object.entries(data)) conversation[key] = value === Prisma.JsonNull ? null : value;
    return conversation;
  } } };
  const engine = new ConversationEngineService(prisma,
    {generatePharmacyReply: never}, new BulaApiService(config, selector, {}),
    {searchMedicine: never, findSymptomSuggestion: () => null, findSymptomOptions: () => null}, search,
    {findAddressByCep: never}, {confirmCheckout: never});
  return { provider, search, conversation, engine, calls, send: (text) => engine.resolveReply(conversation, text) };
}

for (const [canonical, aliases] of Object.entries(RETAIL_SEARCH_ALIASES)) {
  for (const alias of aliases) test(`retail spelling: ${alias} -> ${canonical}`, () => {
    assert.equal(normalizeRetailSearchQuery(`Tem ${alias}?`), canonical);
    assert.equal(normalizeRetailTerms(alias.toUpperCase()), canonical);
    assert.equal(normalizeRetailSearchQuery(canonical), canonical, "normalization is idempotent");
  });
}

for (const [message, query] of [
  ["Olá, gostaria de comprar gilete, por favor", "gillette"],
  ["Vocês têm pasta de dentes Colgate?", "creme dental colgate"],
  ["Qual o preço do sabonete Dove 90 g?", "sabonete dove 90g"],
  ["Preciso de algodão 50g", "algodao 50g"],
  ["Tem refis de gilette mach 3?", "refil de gillette mach3"],
  ["Quero filtro solar Niveia FPS50 50 ml", "protetor solar nivea fps 50 50ml"],
  ["Tem shampoo Treseme 0,4 l?", "shampoo tresemme 400ml"],
]) test(`conversational query retains useful attributes: ${message}`, () => {
  assert.equal(normalizeRetailSearchQuery(message), query);
});

for (const [message, category] of [
  ["escova de dentes Oral B", "escova de dente"],
  ["fio dental Oral-B", "fio dental"],
  ["pasta de dente Oral-B", "creme dental"],
  ["lencinhos umedecidos Pampers", "lenco umedecido"],
  ["toalhas umedecidas Huggies", "lenco umedecido"],
  ["condicionador Treseme", "condicionador"],
  ["shampoo Tresemme", "shampoo"],
  ["sabonetes Nivea", "sabonete"],
  ["cotonetes Johnsons", "cotonete"],
  ["gilete", "gillette"],
  ["Mach 3", "gillette"],
  ["camisinhas Jontex", "preservativo"],
]) test(`explicit category beats shared brand: ${message}`, () => {
  assert.equal(manual.findCatalogKey(message), category);
  assert.equal(manual.isRetailProductQuery(message), true);
});

for (const [query, expected] of [
  ["gilete", /Gillette/],
  ["GILLETTE", /Gillette/],
  ["gilete mach 3", /Mach3/],
  ["refil gilete mach3", /Refil Gillette Mach3/],
  ["xampu Seda 325 ml", /Shampoo Seda 325ml/],
  ["sabonetes Dove 250ml", /Sabonete Liquido Dove 250ml/],
  ["pasta de dentes Colgate", /Creme Dental Colgate/],
  ["escova de dentes Oral B", /Escova Dental Oral-B/],
  ["fio dental oralb", /Fio Dental Oral-B/],
  ["toalhas umedecidas Huggies", /Umedecidos Huggies/],
  ["fraldas Pampers G", /Fraldas Pampers G/],
  ["filtro solar Niveia FPS50 50ml", /FPS 50 50ml/],
  ["desodorante Rexona roll on sem alcool", /Roll-on Sem Alcool/],
  ["camisinhas Jontex", /Preservativos Jontex/],
  ["condicionador Treseme", /Condicionador Tresemme/],
  ["cotonetes Johnsons", /Cotonetes Johnsons/],
]) test(`adapter -> filters -> priced options: ${query}`, async (t) => {
  const h = harness(t);
  const result = await h.search.searchProducts(query);
  assert.ok(result.options.length > 0, query);
  for (const option of result.options) {
    assert.match(option.productName, expected);
    assert.equal(option.source, "preco_popular");
    assert.equal(option.pricePf, catalog.find((product) => product.items[0].itemId === option.sourceId).items[0].sellers[0].commertialOffer.Price);
  }
  assert.equal(h.calls[0].searchParams.get("ft"), normalizeRetailSearchQuery(query));
  assert.equal(h.calls.length, 1);
});

test("screenshot flow: cotonetes -> gilete -> Gillette -> selection -> quantity -> cart", async (t) => {
  const h = harness(t);
  await h.send("Tem cotonetes Johnsons?");
  assert.equal(h.conversation.currentRetailCategory, "cotonete");
  const reply = await h.send("Tem gilete ?");
  assert.match(reply, /Gillette/);
  assert.doesNotMatch(reply, /Não localizei|Cotonete/);
  assert.equal(h.calls.at(-1).searchParams.get("ft"), "gillette");
  const count = h.calls.length;
  await h.send("Tem Gillette ?");
  assert.equal(h.calls.length, count, "same normalized query uses cache");
  await h.send("1");
  const price = h.conversation.selectedPresentation.pricePf;
  await h.send("2");
  assert.equal(h.conversation.cart[0].quantity, 2);
  assert.equal(h.conversation.cart[0].total, Number((price * 2).toFixed(2)));
  assert.match(await h.send("ver carrinho"), /Gillette/);
});

test("category alias asks brand once; conversational brand reply preserves category", async (t) => {
  const h = harness(t);
  assert.match(await h.send("Tem xampu?"), /marca de preferência/);
  assert.equal(h.calls.length, 0);
  await h.send("Pode ser Seda");
  assert.equal(h.calls[0].searchParams.get("ft"), "shampoo seda");
  assert.ok(h.conversation.candidateOptions.every((option) => /Shampoo Seda/.test(option.productName)));
});

test("quero plus a brand is an answer to the pending brand question, not a medicine", async (t) => {
  const h = harness(t);
  await h.send("Tem xampu?");
  await h.send("Quero Seda, por favor");
  assert.equal(h.calls[0].searchParams.get("ft"), "shampoo seda");
  assert.ok(h.conversation.candidateOptions.every((option) => /Shampoo Seda/.test(option.productName)));
});

test("punctuation and polite aliases hit the same cached query", async (t) => {
  const h = harness(t);
  await h.send("Tem gilete?");
  await h.send("Olá, gostaria de comprar gilete, por favor.");
  assert.equal(h.calls.length, 1);
  assert.match(h.conversation.candidateOptions[0].productName, /Gillette/);
});

test("equivalent retail volumes and weights are matched without losing the size", async (t) => {
  const h = harness(t);
  const summary = await h.search.searchProducts("shampoo Pantene 0,4 l");
  assert.equal(summary.options.length, 1);
  assert.match(summary.options[0].productName, /400ml/);
  assert.equal(normalizeRetailTerms("algodao 0,5kg"), "algodao 500g");
});

test("two products in one message prompt a choice, not a false catalog miss", async (t) => {
  const h = harness(t);
  h.conversation.cart = [{name: "Produto anterior", quantity: 1, total: 10}];
  assert.match(await h.send("Tem shampoo e condicionador?"), /começar por qual produto/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.conversation.cart.length, 1);
  assert.match(await h.send("shampoo"), /marca de preferência/);
  await h.send("Seda");
  assert.ok(h.conversation.candidateOptions.length);
});

test("an explicitly requested kit is searched as a kit, not split into a new cart", async (t) => {
  const h = harness(t);
  await h.send("Tem kit shampoo Seda e condicionador?");
  assert.match(h.conversation.selectedPresentation.productName, /Kit Shampoo/);
  assert.equal(h.calls.length, 1);
});

test("new retail query does not inherit a medicine dosage", async (t) => {
  const h = harness(t);
  Object.assign(h.conversation, {currentMedicineQuery: "dipirona", lastMedicine: "dipirona", pendingAction: ConversationState.WAITING_QUANTITY});
  await h.send("Tem sabonetes Dove 250ml?");
  assert.equal(h.conversation.currentRetailCategory, "sabonete");
  assert.equal(h.conversation.selectedPresentation.type, "retail_product");
});

test("bare product/model name can replace the item while quantity is pending", async (t) => {
  const h = harness(t);
  await h.send("Tem sabonete Dove?");
  assert.equal(h.conversation.pendingAction, ConversationState.WAITING_QUANTITY);
  await h.send("Mach 3");
  assert.equal(h.conversation.currentRetailCategory, "gillette");
  assert.equal(h.conversation.cart.length, 0);
  assert.ok(h.conversation.candidateOptions.every((option) => /Mach3/.test(option.productName)));
});

test("diaper size answer keeps a brand supplied in the same reply", async (t) => {
  const h = harness(t);
  assert.match(await h.send("Tem fraldas?"), /tamanho/);
  await h.send("Pampers G");
  assert.match(h.conversation.selectedPresentation.productName, /Pampers G/);
});

test("conversational attribute answers do not contaminate the product search", async (t) => {
  const h = harness(t);
  await h.send("Tem fralda Pampers?");
  await h.send("Quero a G, por favor");
  assert.match(h.conversation.selectedPresentation.productName, /Pampers G/);
  assert.doesNotMatch(h.calls.at(-1).searchParams.get("ft"), /quero|por favor/);
  await h.send("Tem protetor solar Nivea 50ml?");
  await h.send("Pode ser 50, por favor");
  assert.match(h.conversation.selectedPresentation.productName, /FPS 50 50ml/);
});

test("uppercase multi-product request also asks which product to start with", async (t) => {
  const h = harness(t);
  assert.match(await h.send("TEM SHAMPOO E CONDICIONADOR?"), /começar por qual produto/);
  assert.equal(h.calls.length, 0);
});

test("sunscreen volume is never confused with FPS", async (t) => {
  const h = harness(t);
  assert.match(await h.send("Tem filtro solar Nivea 50 ml?"), /Qual FPS/);
  assert.equal(h.calls.length, 0);
  await h.send("50");
  assert.match(h.conversation.selectedPresentation.productName, /FPS 50 50ml/);
});

test("long legitimate names are not rejected because repeated fields exceed 180 chars", async (t) => {
  const product = structuredClone(catalog[6]);
  product.productName = product.items[0].name = "Shampoo Seda Nutrição e Proteção Para Cabelos Danificados Com Extratos Vegetais 325ml";
  const h = harness(t, [product]);
  assert.equal((await h.search.searchProducts("shampoo seda")).options.length, 1);
});

test("volume/model/brand constraints never silently loosen after a miss", async (t) => {
  const h = harness(t);
  for (const query of ["shampoo seda 999ml", "desodorante rexona sem perfume", "shampoo MarcaQueNaoExiste", "gillette modelo inexistente"]) {
    assert.equal((await h.search.searchProducts(query)).options.length, 0, query);
  }
  assert.equal(h.calls.length, 4, "no speculative fallback requests");
});

test("negative qualifier and FPS must be attached to the requested attribute", () => {
  assert.equal(matchesRetailQuery("Desodorante sem parabenos com alcool", "desodorante sem alcool", "desodorante"), false);
  assert.equal(matchesRetailQuery("Protetor solar FPS30 50ml", "protetor solar FPS50", "protetor solar"), false);
});

test("GTIN is only recognized as a complete identifier, not numbers concatenated from text", () => {
  assert.equal(extractRetailGtin("EAN 7891234567890"), "7891234567890");
  assert.equal(extractRetailGtin("7891234567890"), "7891234567890");
  assert.equal(extractRetailGtin("shampoo 1234ml kit 5678"), null);
  assert.equal(extractRetailGtin("produto 12345678"), null);
});

test("no fuzzy medicine substitutions or matches inside unrelated words", () => {
  for (const name of ["hidralazina", "hidroxizina", "clonazepam", "clobazam", "venvanse 50mg", "dipirona 1g", "kylie", "pantoprazol"]) {
    assert.equal(normalizeRetailTerms(name), name);
    assert.equal(manual.isRetailProductQuery(name), false, name);
  }
  assert.equal(normalizeRetailTerms("agiletenao"), "agiletenao");
});

test("brand suggestions do not claim demand or stock without data", () => {
  assert.doesNotMatch(WhatsappCopy.askRetailBrand("shampoo", ["Seda"]), /mais pedidas|disponíveis|estoque/i);
});
