const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Logger } = require("@nestjs/common");
const { Prisma, ConversationState } = require("@prisma/client");
const { PrecoPopularService } = require("../dist/integrations/preco-popular.service");
const { CommercialMedicineSelector } = require("../dist/integrations/commercial-medicine-selector");
const { MedicineSearchOrchestratorService } = require("../dist/integrations/medicine-search-orchestrator.service");
const { ProductSearchOrchestratorService } = require("../dist/integrations/product-search-orchestrator.service");
const { ManualRetailProductService } = require("../dist/integrations/manual-retail-product.service");
const { BulaApiService } = require("../dist/integrations/bula-api.service");
const { ConversationEngineService } = require("../dist/whatsapp/conversation-engine.service");
const { DEFAULT_MEDICINE_PRIORITY_RULES } = require("../dist/config/medicine-priority-rules.config");
const { extractMedicineStrengths, medicineStrengthMatches, medicineStrengthSignature } = require("../dist/utils/medicine-strength.util");
const { formatProductDisplayName } = require("../dist/whatsapp/whatsapp-copy");
const { captures } = require("./fixtures/catalog-2026-09-23.json");
const { medicines, variations } = require("./catalog-diagnostic-cases");

Logger.overrideLogger(false);
global.fetch = async () => { throw new Error("Network forbidden in regression tests"); };
const config = { get: () => undefined };
const never = async () => assert.fail("Unexpected database/AI/payment dependency");
const recorded = new Map(captures.map((capture) => [capture.endpoint, capture]));
const sourceSkus = new Map(captures.flatMap((capture) => capture.body.flatMap((product) => product.items)).map((item) => [item.itemId, item]));
const knownUncapturedPages = new Set(["anlodipino", "hidroclorotiazida"]);

function harness(t, responder) {
  const calls = [];
  t.mock.method(global, "fetch", async (input, init) => {
    const url = new URL(input);
    calls.push(url);
    if (responder) return responder(url, init, calls.length);
    const capture = recorded.get(String(input));
    if (!capture) {
      assert.ok(knownUncapturedPages.has(url.searchParams.get("ft")) && url.searchParams.get("_from") === "100", `Unrecorded URL: ${url}`);
      // The audit stopped at two pages; do not pretend this is an empty real page.
      throw new Error("Third page was not captured in the live audit");
    }
    return response(capture.body, capture.status, {resources: capture.resources});
  });
  const selector = new CommercialMedicineSelector();
  const provider = new PrecoPopularService(config, selector);
  const rules = { getRulesForPrinciple: async (name) => DEFAULT_MEDICINE_PRIORITY_RULES.filter((rule) => rule.principleActive === name) };
  const search = new MedicineSearchOrchestratorService(selector, {findSymptomOptions: () => null, findSymptomSuggestion: () => null}, rules, provider);
  const retail = new ProductSearchOrchestratorService(new ManualRetailProductService(), provider);
  const conversation = {
    id: "offline", customerId: "offline", pendingAction: ConversationState.IDLE,
    lastIntent: null, lastMedicine: null, currentMedicineQuery: null, currentRetailCategory: null,
    selectedPresentation: null, candidateOptions: [], cart: [], pendingAddress: null,
  };
  const prisma = {conversation: {update: async ({data}) => {
    for (const [key, value] of Object.entries(data)) conversation[key] = value === Prisma.JsonNull ? null : value;
    return conversation;
  }}};
  const engine = new ConversationEngineService(prisma,
    {canReadPackageImages: () => false, generatePharmacyReply: never},
    new BulaApiService(config, selector, rules), search, retail,
    {findAddressByCep: never}, {confirmCheckout: never});
  return {selector, provider, search, retail, conversation, engine, calls,
    send: (text) => engine.resolveReply(conversation, text)};
}
function response(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {status, headers});
}
function fakeProduct(id, name) {
  return {productId: String(id), productName: name, categories: ["/Medicamentos/"],
    "Princípio ativo": ["teste"], items: [{itemId: String(id), name,
      sellers: [{commertialOffer: {Price: 10, AvailableQuantity: 1}}]}]};
}

for (const [actual, requested, expected] of [
  ["1g", "1000mg", true], ["0,5g", "500mg", true],
  ["50mcg", "0,05mg", true], ["25mcg", "50mcg", false],
  ["37,5mcg", "25mcg", false], ["50mg", "50mcg", false],
  ["250mg/5ml", "50mg/ml", true], ["250mg/5ml", "250mg/ml", false],
  ["500mg", "500mg/ml", false], ["10mg/g", "10mg/ml", false],
  ["6,67mg/ml + 333,4mg/ml", "6,67mg/ml", false],
  ["400mg + 4mg + 4mg", "400mg + 4mg", false],
]) test(`strength comparison: ${actual} vs ${requested} = ${expected}`, () => {
  assert.equal(medicineStrengthMatches(actual, requested), expected);
});

test("query parsing preserves names, micrograms, concentration and package quantity", () => {
  const selector = new CommercialMedicineSelector();
  for (const [text, name, dose, quantity] of [
    ["Tem Puran T4 25mcg?", "puran t4", "25mcg", undefined],
    ["AMOXICILINA 250mg/5ml", "amoxicilina", "250mg/5ml", undefined],
    ["Dorflex 30 comprimidos", "dorflex", undefined, 30],
    ["2 caixas de Venvanse 50mg com 28 cápsulas", "venvanse", "50mg", 28],
  ]) {
    const parsed = selector.parseMedicineQuery(text);
    assert.equal(parsed.medicineName, name, text);
    assert.equal(parsed.dosage, dose, text);
    assert.equal(parsed.packageQuantity, quantity, text);
  }
  assert.equal(selector.getCanonicalMedicineName("Plenance"), "rosuvastatina");
});

test("package weights are not strengths; gram tablets remain gram tablets", () => {
  for (const name of ["Tamarine geleia 150g", "Minancora pomada 30g", "Resfenol po para solucao oral 5g", "5 saches 5g cada"]) {
    assert.deepEqual(extractMedicineStrengths(name), [], name);
  }
  assert.equal(medicineStrengthSignature("Polaramine creme 10mg/g 30g"), "10mg/g");
  assert.equal(medicineStrengthSignature("Dipirona 1g 10 comprimidos"), "1000mg");
});

test("full labels preserve every decimal strength, volume and accessory", () => {
  for (const id of ["3385", "3384", "19453", "19466"]) {
    const raw = sourceSkus.get(id).name;
    const display = formatProductDisplayName(raw);
    assert.equal(medicineStrengthSignature(display), medicineStrengthSignature(raw));
    assert.match(display, /\b(?:60|150)ml\b/i);
    assert.match(display, /seringa|copinho/i);
  }
  for (const raw of [
    "Buscopan Composto Butilbrometo De Escopolamina 6,67mg/ml + Dipirona 333,4mg/ml Solucao Oral 20ml",
    "Polaramine Dexclorfeniramina 0,4mg/ml Solucao Oral Antialergico Sabor Framboesa 120ml",
  ]) assert.equal(medicineStrengthSignature(formatProductDisplayName(raw)), medicineStrengthSignature(raw));
});

test("compound brands are searchable, not silent substitutes for single ingredients", () => {
  const selector = new CommercialMedicineSelector();
  const same = (query, name, substance) => selector.isSameMedicine(query, {id: 1, name, substance: {name: substance}});
  assert.equal(same("resfenol", "Resfenol 10 capsulas", "Paracetamol; Fenilefrina; Clorfeniramina"), true);
  assert.equal(same("paracetamol", "Paracetamol + Fenilefrina", "Paracetamol; Fenilefrina"), false);
  assert.equal(same("allegra", "Allegra D 60mg + 120mg", "Fexofenadina; Pseudoefedrina"), false);
  assert.equal(same("allegra d", "Allegra D 60mg + 120mg", "Fexofenadina; Pseudoefedrina"), true);
  assert.equal(same("plenance", "Plenance Eze", "Rosuvastatina; Ezetimiba"), false);
  assert.equal(same("plenance eze", "Plenance Eze", "Rosuvastatina; Ezetimiba"), true);
});

for (const query of [...medicines, ...variations]) {
  test(`captured real catalog -> complete conversation selection: ${query}`, async (t) => {
    const h = harness(t);
    const reply = await h.send(`Tem ${query}?`);
    assert.doesNotMatch(reply, /orçamento manual|Tadalafila.*Plenance/is);
    const options = h.conversation.candidateOptions || [];
    if (["dorflex 30 comprimidos", "allegra suspensao oral", "neosoro 0,5mg/ml"].includes(query)) {
      assert.equal(options.length, 0);
      assert.equal(h.conversation.selectedPresentation, null);
      if (query !== "dorflex 30 comprimidos") assert.match(reply, /não está disponível para pedido/);
      else assert.match(reply, /não essa dosagem ou apresentação/);
      return;
    }
    assert.ok(options.length >= 1 && options.length <= 3, reply);
    const parsed = h.selector.parseMedicineQuery(query);
    for (const option of options) {
      const raw = sourceSkus.get(option.sourceId);
      assert.ok(raw, option.label);
      assert.equal(option.pricePf, raw.sellers.find((seller) => seller.commertialOffer.Price > 0).commertialOffer.Price);
      assert.ok(!option.packageInfo?.isInjectable && !option.packageInfo?.isHospitalUse);
      assert.notEqual(option.ean, "7891058003555");
      assert.equal(medicineStrengthSignature(option.label), medicineStrengthSignature(raw.name));
      if (parsed.dosage) assert.ok(medicineStrengthMatches(option.strength || "", parsed.dosage), option.label);
      if (parsed.packageQuantity) assert.equal(option.packageInfo?.unitCount, parsed.packageQuantity);
      if (query === "plenance") assert.doesNotMatch(option.label, /tadalafila|eze/i);
      if (query === "cimegripe") assert.doesNotMatch(option.label, /zinco/i);
    }
    if (query === "venvanse") assert.deepEqual(options.map((option) => option.strength).sort(), ["30mg", "50mg", "70mg"]);
    if (query === "minancora") assert.doesNotMatch(reply, /Qual marca/);
    // Select an actual option, then add one box. No payment or WhatsApp is sent.
    if (options.length > 1) await h.send("1");
    await h.send("1");
    assert.equal(h.conversation.cart.length, 1);
    assert.equal(h.conversation.cart[0].unitPrice, options[0].pricePf);
    assert.equal(h.conversation.cart[0].dosage || "", options[0].strength || "");
  });
}

test("microgram cache is isolated and contextual strength changes preserve the medicine", async (t) => {
  const h = harness(t);
  await h.send("Tem Puran T4?");
  await h.send("Tem de 25mcg?");
  assert.equal(h.conversation.selectedPresentation.strength, "25mcg");
  await h.send("Tem de 50mcg?");
  assert.equal(h.conversation.selectedPresentation.strength, "50mcg");
  await h.send("Tem Euthyrox 50mcg?");
  assert.match(h.conversation.selectedPresentation.productName, /Euthyrox/i);
  assert.equal(h.calls.length, 2);
  await h.send("Tem de 1mg?");
  assert.equal(h.conversation.selectedPresentation, null);
  assert.equal(h.conversation.candidateOptions, null);
  await h.send("1");
  assert.equal(h.conversation.cart.length, 0);
});

test("name cache shares mass-equivalent queries, never confuses liquid with solid", async (t) => {
  const h = harness(t);
  const a = await h.search.searchMedicine("amoxicilina 250mg/5ml");
  const b = await h.search.searchMedicine("amoxicilina 50mg/ml");
  assert.deepEqual(a.options, b.options);
  const c = await h.search.searchMedicine("amoxicilina 250mg");
  assert.ok(c.options.every((option) => !option.strength.includes("/")));
  assert.equal(h.calls.length, 1);
});

test("contextual dose keeps pack/form constraints and a missing unit is clarified", async (t) => {
  const h = harness(t);
  await h.send("Tem Venvanse?");
  await h.send("Tem de 50mg com 28 capsulas?");
  assert.equal(h.conversation.selectedPresentation.strength, "50mg");
  assert.equal(h.conversation.selectedPresentation.packageInfo.unitCount, 28);
  const count = h.calls.length;
  assert.match(await h.send("Tem de 50?"), /dosagem com a unidade/);
  assert.equal(h.calls.length, count);
  assert.equal(h.conversation.selectedPresentation, null);
  await h.send("50mg");
  assert.equal(h.conversation.selectedPresentation.strength, "50mg");
  await h.send("Tem Venvanse 50mg gotas?");
  assert.equal(h.conversation.selectedPresentation, null);
  assert.equal(h.conversation.candidateOptions, null);
});

test("liquid titles with no denominator do not become confirmed tablet strengths", async (t) => {
  const h = harness(t);
  const options = await h.provider.searchMedicines("clonazepam");
  const incomplete = options.find((option) => /Gotas/i.test(option.productName) && /2,5mg /i.test(option.productName));
  assert.ok(incomplete);
  assert.equal(incomplete.dosage, undefined);
  const summary = await h.search.searchMedicine("clonazepam 2,5mg");
  assert.equal(summary.options.length, 0);
  assert.equal(summary.searchStatus, "attributes_unverified");
});

test("generic label images are omitted rather than presented as packaging photos", async (t) => {
  const h = harness(t);
  const options = await h.provider.searchMedicines("amoxicilina");
  assert.ok(options.some((option) => !option.imageUrl));
  assert.ok(options.every((option) => !/rotulo_pp_|Similar_Tarja/i.test(option.imageUrl || "")));
});

for (const reason of ["no_price", "out_of_stock"]) test(`existing catalog product with ${reason} is not reported as nonexistent`, async (t) => {
  const product = fakeProduct(1, "Teste 10mg 30 comprimidos");
  if (reason === "no_price") product.items[0].sellers[0].commertialOffer.Price = 0;
  else product.items[0].sellers[0].commertialOffer.AvailableQuantity = 0;
  const h = harness(t, () => response([product]));
  const summary = await h.search.searchMedicine("teste");
  assert.equal(summary.searchStatus, "offer_unavailable");
  assert.equal(summary.failureReason, reason);
  assert.equal(summary.options.length, 0);
});

test("quarantined SKU/EAN cannot be recovered through exact checkout refresh", async (t) => {
  const quarantined = captures.flatMap((capture) => capture.body).find((product) => product.items.some((item) => item.itemId === "6291"));
  const h = harness(t, () => response([quarantined]));
  assert.equal(await h.provider.findCurrentOffer({source: "preco_popular", sourceId: "6291", ean: "7891058003555"}), null);
  h.conversation.cart = [{source: "preco_popular", sourceId: "6291", ean: "7891058003555", pricePolicy: "preco_popular_full_v1", name: "Puran", quantity: 1, total: 10}];
  assert.match((await h.engine.refreshCheckoutPrices(h.conversation)).error, /não está disponível para pedido/);
});

test("HTTP failure and cooldown are unavailable, not product absence, and recover", async (t) => {
  const h = harness(t, (url, _init, count) => count === 1 ? response({}, 500) : response([fakeProduct(1, url.searchParams.get("ft") + " 50mg 10 comprimidos")]));
  assert.match(await h.send("Tem dipirona?"), /Não consegui consultar/);
  assert.match(await h.send("Tem novalgina?"), /Não consegui consultar/);
  assert.equal(h.calls.length, 1);
  h.provider.cooldownUntil = 0;
  assert.equal((await h.search.searchMedicine("dipirona")).options.length, 1);
  assert.equal(h.calls.length, 2);
});

test("retail outage gets the same honest failure message", async (t) => {
  const h = harness(t, () => response({}, 500));
  assert.match(await h.send("Tem sabonete Dove?"), /Não consegui consultar/);
});

test("pagination reaches third page while staying bounded at four pages", async (t) => {
  const h = harness(t, (url) => {
    const start = Number(url.searchParams.get("_from"));
    return response(Array.from({length: start === 100 ? 20 : 50}, (_, index) => fakeProduct(start + index, `Teste ${start + index + 1}mg`)), 206, {resources: `${start}-${start + 49}/120`});
  });
  const result = await h.provider.searchMedicinesWithStatus("teste");
  assert.equal(result.options.length, 120);
  assert.equal(result.status, "ok");
  assert.equal(h.calls.length, 3);
});

test("pagination limit and failed later pages are explicitly incomplete", async (t) => {
  const h = harness(t, (url) => {
    const start = Number(url.searchParams.get("_from"));
    return response(Array.from({length: 50}, (_, index) => fakeProduct(start + index, `Teste ${index + 1}mg`)), 206, {resources: `${start}-${start + 49}/500`});
  });
  const result = await h.provider.searchMedicinesWithStatus("teste");
  assert.equal(result.options.length, 200);
  assert.equal(result.status, "incomplete");
  assert.equal(result.failureReason, "pagination_limit");
  assert.equal(h.calls.length, 4);
});

test("injections are rejected even if the selector is used without the orchestrator", () => {
  const selector = new CommercialMedicineSelector();
  const info = selector.extractPackageInfo("Lasix solucao injetavel 10mg/ml 5 ampolas 2ml");
  assert.equal(info.isInjectable, true);
  assert.deepEqual(selector.selectCommercialOptions("furosemida", [{productName: "Lasix", medicineName: "furosemida", presentationId: 1, formGroup: "outro", strength: "10mg/ml", packageInfo: info, pricePf: 20}]), []);
});
