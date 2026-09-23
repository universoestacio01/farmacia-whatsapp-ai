const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Logger } = require("@nestjs/common");
const { Prisma, ConversationState: State } = require("@prisma/client");
const { CommercialMedicineSelector } = require("../dist/integrations/commercial-medicine-selector");
const { PrecoPopularService } = require("../dist/integrations/preco-popular.service");
const { MedicineSearchOrchestratorService } = require("../dist/integrations/medicine-search-orchestrator.service");
const { BulaApiService } = require("../dist/integrations/bula-api.service");
const { ConversationEngineService } = require("../dist/whatsapp/conversation-engine.service");
const { ConversationInputService } = require("../dist/whatsapp/conversation-input.service");

Logger.overrideLogger(false);
const never = async () => assert.fail("Unexpected network, AI, database, or payment call");
global.fetch = never;
const config = { get: () => undefined };

// Minimal product fields observed in the live API on 2026-09-23, not a manual offer.
const product = {
  productId: "329", productName: "Paregórico Catarinense Elixir 30ml",
  brand: "Catarinense Pharma", categories: ["/Medicamentos/Aparelho Digestivo/Digestivo/", "/Medicamentos/"],
  items: [{ itemId: "3494", name: "Paregorico Catarinense Elixir 30ml", ean: "7896023701436",
    sellers: [{ commertialOffer: { Price: 24.12, ListPrice: 27.98, IsAvailable: true, AvailableQuantity: 99999 } }] }],
};

function harness(t, { responder, backups = false } = {}) {
  const calls = [];
  t.mock.method(global, "fetch", async (input) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://www.precopopular.com.br");
    calls.push(url);
    if (responder) return responder(url);
    const found = ["elixir paregorico", "paregorico"].includes(url.searchParams.get("ft"));
    return new Response(JSON.stringify(found ? [product] : []), { status: 200 });
  });
  const selector = new CommercialMedicineSelector();
  const events = [];
  const provider = new PrecoPopularService(config, selector, { record: async (e) => events.push(e) });
  const rules = { getRulesForPrinciple: async () => [] };
  const backupCalls = [];
  const backup = (name) => ({ name, isEnabled: () => true, searchWithStatus: async () => {
    backupCalls.push(name);
    return { options: [], status: "unavailable" };
  } });
  const search = new MedicineSearchOrchestratorService(selector, { findSymptomSuggestion: () => null }, rules, provider,
    backups ? backup("openai_web") : undefined, { record: async (event) => events.push(event) });
  const conversation = { id: "offline", customerId: "offline", pendingAction: State.WAITING_MEDICINE_NAME,
    lastIntent: null, lastMedicine: null, currentMedicineQuery: null, currentRetailCategory: null,
    selectedPresentation: null, candidateOptions: [], cart: [], pendingAddress: null };
  const prisma = { conversation: { update: async ({ data }) => {
    for (const [key, value] of Object.entries(data)) conversation[key] = value === Prisma.JsonNull ? null : value;
    return conversation;
  } } };
  const engine = new ConversationEngineService(prisma, { generatePharmacyReply: never, canReadPackageImages: () => false },
    new BulaApiService(config, selector, rules), search, { isRetailProductQuery: () => false }, {}, { confirmCheckout: never },
    new ConversationInputService(), provider);
  return { selector, search, provider, engine, calls, backupCalls, events, conversation, send: (text) => engine.resolveReply(conversation, text) };
}

for (const query of ["Elexir paregórico", "Elixir paregórico", "ELExIR   PAREGÓRICO", "Tem elexir paregórico?", "Olá, quero elixir paregórico", "Elixir paregórico 30ml", "Paregórico"]) {
  test(`catalog and conversation find the screenshot product: ${query}`, async (t) => {
    const f = harness(t, { backups: true });
    const reply = await f.send(query);
    assert.match(reply, /Paregórico Catarinense Elixir 30ml/);
    assert.match(reply, /24,12/);
    assert.doesNotMatch(reply, /Não localizei|Não consegui concluir/);
    assert.equal(f.conversation.selectedPresentation.ean, "7896023701436");
    assert.equal(f.conversation.selectedPresentation.pricePf, 24.12);
    assert.equal(f.conversation.selectedPresentation.strength, undefined, "Do not invent concentration from the 30ml volume");
    assert.equal(f.calls.length, 1);
    assert.equal(f.events[0].statusCode, 200);
    assert.equal(f.events[0].resultsFound, 1);
    assert.deepEqual(f.backupCalls, []);
    await f.send("2");
    assert.equal(f.conversation.cart[0].unitPrice, 24.12);
    assert.equal(f.conversation.cart[0].total, 48.24);
  });
}

test("spelling, accent and spacing variants reuse the same cache", async (t) => {
  const f = harness(t);
  for (const query of ["Elexir paregórico", "Elixir paregorico", " ELIXIR   PAREGÓRICO "])
    assert.equal((await f.search.searchMedicine(query)).options.length, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].searchParams.get("ft"), "elixir paregorico");
});

for (const [query, name] of [
  ["elixir paregorico", "Paregórico Catarinense Elixir 30ml"],
  ["paregorico elixir", "Elixir Catarinense Paregórico 30ml"],
  ["vitamina c", "Vitamina Suplemento C"],
  ["oleo mineral", "Óleo Farmácia Mineral 100ml"],
]) test(`whole name words match across order/manufacturer insertion: ${query}`, () => {
  const selector = new CommercialMedicineSelector();
  assert.equal(selector.isSameMedicine(query, { id: 1, name }), true);
});

for (const [query, row] of [
  ["elixir paregorico", { name: "Elixir de outro produto" }],
  ["elixir paregorico", { name: "Paregórico 30ml", manufacturer: { name: "Elixir" } }],
  ["elixir paregorico", { name: "Elixir 30ml", substance: { name: "paregorico" } }],
  ["elixir paregorico", { name: "Paregoricona Elixir 30ml" }],
  ["elixir paregorico", { name: "Paregórico Elixir Composto 30ml" }],
  ["vitamina c", { name: "Vitamina cálcio" }],
  ["lorazepam", { name: "Clonazepam" }],
  ["hidralazina", { name: "Hidroxizina" }],
]) test(`no missing-word, substring, metadata or fuzzy substitution: ${query}/${row.name}`, () => {
  assert.equal(new CommercialMedicineSelector().isSameMedicine(query, { id: 1, ...row }), false);
});

for (const query of ["elixir paregorico 1mg", "elixir paregorico comprimidos"]) {
  test(`name matching cannot relax requested strength/form: ${query}`, async (t) => {
    const f = harness(t);
    assert.equal((await f.search.searchMedicine(query)).options.length, 0);
  });
}

test("empty primary plus failing backups is distinguishable in structured logs", async (t) => {
  const logs = [];
  t.mock.method(Logger.prototype, "log", (message) => logs.push(message));
  const f = harness(t, { backups: true, responder: () => new Response("[]", { status: 200 }) });
  const result = await f.search.searchMedicine("elixir paregorico");
  assert.equal(result.searchStatus, "backup_unavailable");
  const outcome = logs.map((x) => { try { return JSON.parse(x); } catch { return {}; } }).find((x) => x.event === "MEDICINE_SEARCH_OUTCOME");
  assert.equal(outcome.primaryStatus, "not_found");
  assert.equal(outcome.backupUnavailable, true);
  assert.equal(outcome.finalStatus, "backup_unavailable");
  assert.equal(f.events[0].statusCode, 200);
});

test("actual primary failure retains its cause, instead of being logged as a spelling miss", async (t) => {
  const f = harness(t, { responder: () => new Response("{}", { status: 503 }) });
  const result = await f.search.searchMedicine("elixir paregorico");
  assert.equal(result.searchStatus, "unavailable");
  assert.equal(result.failureReason, "HTTP 503");
  assert.equal(f.calls.length, 1);
});
