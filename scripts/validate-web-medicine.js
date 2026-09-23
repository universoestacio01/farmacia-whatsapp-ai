const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Logger } = require("@nestjs/common");
const { Prisma, ConversationState: State } = require("@prisma/client");
const {
  CommercialMedicineSelector,
} = require("../dist/integrations/commercial-medicine-selector");
const {
  extractVerifiedWebOptions,
} = require("../dist/integrations/web-medicine-offer");
const {
  OpenAiWebMedicineService,
} = require("../dist/integrations/openai-web-medicine.service");
const {
  MedicineSearchOrchestratorService,
} = require("../dist/integrations/medicine-search-orchestrator.service");
const {
  ConversationEngineService,
} = require("../dist/whatsapp/conversation-engine.service");
const {
  ConversationInputService,
} = require("../dist/whatsapp/conversation-input.service");
const { BulaApiService } = require("../dist/integrations/bula-api.service");
const {
  PharmaDbAuthService,
} = require("../dist/integrations/pharmadb-auth.service");
const { PharmaDbService } = require("../dist/integrations/pharmadb.service");
const {
  BulapiCatalogService,
} = require("../dist/integrations/bulapi-catalog.service");
const {
  WEB_MEDICINE_PRICE_POLICY,
  safeMedicineProductUrl,
  validWebQuote,
} = require("../dist/config/web-medicine.config");
Logger.overrideLogger(false);
const selector = new CommercialMedicineSelector();
const URL = "https://drogaraia.com.br/dipirona-1g-10-comprimidos.html";
const config = (extra = {}) => ({
  get: (key) => ({ OPENAI_API_KEY: "test-secret", ...extra })[key],
});
const offer = (extra = {}) => ({
  "@type": "Offer",
  price: "19.90",
  priceCurrency: "BRL",
  availability: "https://schema.org/InStock",
  ...extra,
});
const product = (extra = {}) => ({
  "@type": "Product",
  name: "Dipirona 1g com 10 Comprimidos",
  url: URL,
  offers: offer(),
  ...extra,
});
const html = (data) =>
  `<html><head><script type="application/ld+json">${JSON.stringify(data)}</script></head></html>`;
const options = (data = product(), query = "dipirona 1g com 10 comprimidos") =>
  extractVerifiedWebOptions(html(data), URL, query, selector);
const discovery = (urls = [URL], sources = urls) => ({
  status: "completed",
  output: [
    {
      type: "web_search_call",
      status: "completed",
      action: { type: "search", sources: sources.map((url) => ({ url })) },
    },
    {
      type: "message",
      content: [{ type: "output_text", text: JSON.stringify({ urls }) }],
    },
  ],
});
function harness(t, extra = {}) {
  const calls = [],
    logs = [];
  t.mock.method(global, "fetch", async (url, request = {}) => {
    calls.push({ url: String(url), request });
    if (String(url).includes("api.openai.com")) {
      if (extra.api) return extra.api(url, request);
      return new Response(JSON.stringify(discovery()), { status: 200 });
    }
    assert.equal(
      request.headers.Authorization,
      undefined,
      "Do not send API key to pharmacy",
    );
    if (extra.page) return extra.page(url, request);
    return new Response(html(product()), {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  });
  const service = new OpenAiWebMedicineService(config(extra.config), selector, {
    record: async (event) => logs.push(event),
  });
  return { calls, logs, service };
}

test("verified price uses exactly the published amount, without 10% discount", () => {
  const [result] = options();
  assert.equal(result.salePrice, 19.9);
  assert.equal(result.webQuote.priceCents, 1990);
  assert.equal(result.webQuote.sourceUrl, URL);
  assert.equal(result.source, "openai_web");
});
test("equivalent strength 1000mg matches 1g", () =>
  assert.equal(
    options(product({ name: "Dipirona 1000mg com 10 Comprimidos" })).length,
    1,
  ));
for (const [label, item] of [
  ["other dose", product({ name: "Dipirona 500mg com 10 Comprimidos" })],
  ["other package", product({ name: "Dipirona 1g com 20 Comprimidos" })],
  ["other medicine", product({ name: "Paracetamol 1g com 10 Comprimidos" })],
  ["missing packaging", product({ name: "Dipirona 1g" })],
  ["injectable", product({ name: "Dipirona 1g Injetavel com 10 Ampolas" })],
  ["missing price", product({ offers: offer({ price: undefined }) })],
  ["zero price", product({ offers: offer({ price: 0 }) })],
  ["foreign currency", product({ offers: offer({ priceCurrency: "USD" }) })],
  [
    "no stock",
    product({
      offers: offer({ availability: "https://schema.org/OutOfStock" }),
    }),
  ],
  ["unknown stock", product({ offers: offer({ availability: undefined }) })],
  [
    "CPF discount",
    product({ offers: offer({ description: "Preco exclusivo com CPF" }) }),
  ],
  ["coupon", product({ offers: offer({ name: "Use cupom" }) })],
  ["loyalty", product({ offers: offer({ validForMemberTier: "gold" }) })],
  ["installment", product({ offers: offer({ description: "3 parcelas" }) })],
  ["minimum quantity", product({ offers: offer({ eligibleQuantity: 3 }) })],
  [
    "expired price",
    product({ offers: offer({ priceValidUntil: "2020-01-01" }) }),
  ],
  [
    "aggregate from price",
    product({
      offers: {
        "@type": "AggregateOffer",
        lowPrice: 19.9,
        priceCurrency: "BRL",
      },
    }),
  ],
  [
    "ambiguous offers",
    product({ offers: [offer(), offer({ price: "29.90" })] }),
  ],
  ["another page", product({ url: "https://drogaraia.com.br/other.html" })],
])
  test(`reject ${label}`, () => assert.equal(options(item).length, 0));

test("malformed JSON-LD and script content cannot execute", () => {
  assert.equal(
    extractVerifiedWebOptions(
      '<script type="application/ld+json">alert(1)</script>',
      URL,
      "dipirona",
      selector,
    ).length,
    0,
  );
});
test("schema graph and single product are supported", () =>
  assert.equal(options({ "@graph": [product()] }).length, 1));
test("real storefront omits 'com' before tablet quantity", () =>
  assert.equal(
    options(
      product({
        name: "Dipirona Monohidratada 1g 10 Comprimidos Prati Genérico",
      }),
    ).length,
    1,
  ));
test("concrete single-package Offer nested in AggregateOffer is verified, not the advertised lowPrice", () => {
  const result = options(
    product({
      offers: { "@type": "AggregateOffer", lowPrice: 0.1, offers: [offer()] },
    }),
  );
  assert.equal(result[0].salePrice, 19.9);
});
test("nested offer with other SKU cannot supply the package price", () => {
  assert.equal(
    options(
      product({
        sku: "sku1",
        offers: { "@type": "AggregateOffer", offers: [offer({ sku: "sku2" })] },
      }),
    ).length,
    0,
  );
});
for (const url of [
  "http://drogaraia.com.br/a.html",
  "https://drogaraia.com.br.evil.test/a.html",
  "https://127.0.0.1/a.html",
  "https://user:secret@drogaraia.com.br/a.html",
  "https://drogaraia.com.br:444/a.html",
  "https://drogaraia.com.br/search?q=dipirona",
]) {
  test(`block non-product or unsafe URL ${url}`, () =>
    assert.equal(safeMedicineProductUrl(url), null));
}
test("named brand cannot become a different brand", () => {
  assert.equal(
    options(
      product({ name: "Dipirona 1g com 10 Comprimidos" }),
      "Novalgina 1g com 10 comprimidos",
    ).length,
    0,
  );
});
test("discovery executes web search, verifies actual page, caches, and never leaks credentials", async (t) => {
  const f = harness(t);
  const result = await f.service.searchWithStatus(
    "Tem dipirona 1g com 10 comprimidos?",
  );
  assert.equal(result.status, "ok");
  assert.equal(result.options[0].salePrice, 19.9);
  const request = JSON.parse(f.calls[0].request.body);
  assert.equal(request.store, false);
  assert.equal(request.tools[0].type, "web_search");
  assert.ok(
    request.tools[0].filters.allowed_domains.includes("drogaraia.com.br"),
  );
  assert.equal(request.tool_choice, "required");
  assert.equal(request.max_tool_calls, 2);
  await f.service.searchWithStatus("Tem dipirona 1g com 10 comprimidos?");
  assert.equal(f.calls.length, 2);
  assert.ok(!JSON.stringify(f.logs).includes("test-secret"));
});
test("concurrent identical searches share one request", async (t) => {
  const f = harness(t);
  await Promise.all([
    f.service.searchWithStatus("dipirona 1g com 10 comprimidos"),
    f.service.searchWithStatus("dipirona 1g com 10 comprimidos"),
  ]);
  assert.equal(f.calls.length, 2);
});
test("AI hallucinated URL without retrieved source is not fetched", async (t) => {
  const f = harness(t, {
    api: () => new Response(JSON.stringify(discovery([URL], []))),
  });
  assert.equal(
    (await f.service.searchWithStatus("dipirona")).options.length,
    0,
  );
  assert.equal(f.calls.length, 1);
});
test("price in model output alone is never a sellable offer", async (t) => {
  const f = harness(t, {
    page: () =>
      new Response("Dipirona custa R$ 1,00", {
        headers: { "content-type": "text/html" },
      }),
  });
  assert.equal(
    (await f.service.searchWithStatus("dipirona")).status,
    "unverified",
  );
});
test("API quota stops calls and does not turn into product not-found", async (t) => {
  const f = harness(t, { api: () => new Response("{}", { status: 429 }) });
  assert.equal(
    (await f.service.searchWithStatus("dipirona")).status,
    "unavailable",
  );
  assert.equal(
    (await f.service.searchWithStatus("paracetamol")).failureReason,
    "local_budget_or_cooldown",
  );
  assert.equal(f.calls.length, 1);
});
test("daily discovery cap and disabled provider never call external API", async (t) => {
  const f = harness(t, { config: { OPENAI_WEB_SEARCH_DAILY_LIMIT: 0 } });
  assert.equal(
    (await f.service.searchWithStatus("dipirona")).status,
    "unavailable",
  );
  assert.equal(f.calls.length, 0);
  const service = new OpenAiWebMedicineService(
    config({ OPENAI_WEB_SEARCH_ENABLED: false }),
    selector,
  );
  assert.equal((await service.searchWithStatus("dipirona")).status, "disabled");
});
test("unsafe redirects and oversized pages fail closed", async (t) => {
  const f = harness(t, {
    page: () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/private" },
      }),
  });
  assert.equal(
    (await f.service.searchWithStatus("dipirona")).options.length,
    0,
  );
  assert.equal(f.calls.length, 2);
});
test("JSON response without executed search is rejected", async (t) => {
  const body = discovery();
  body.output.shift();
  const f = harness(t, { api: () => new Response(JSON.stringify(body)) });
  assert.equal(
    (await f.service.searchWithStatus("dipirona")).status,
    "unavailable",
  );
  assert.equal(f.calls.length, 1);
});
test("primary succeeds without spending any web-search call", async () => {
  let searches = 0;
  const normalized = { ...options()[0], source: "preco_popular" };
  const primary = {
    isEnabled: () => true,
    searchMedicinesWithStatus: async () => ({
      status: "ok",
      options: [normalized],
    }),
  };
  const web = {
    isEnabled: () => true,
    searchWithStatus: async () => {
      searches++;
      throw new Error("Unexpected call");
    },
  };
  const service = new MedicineSearchOrchestratorService(
    selector,
    {},
    { getRulesForPrinciple: async () => [] },
    primary,
    web,
  );
  assert.equal(
    (await service.searchMedicine("dipirona 1g")).options[0].source,
    "preco_popular",
  );
  assert.equal(searches, 0);
});
test("primary outage activates web backup and preserves source quote", async () => {
  const primary = {
    isEnabled: () => true,
    searchMedicinesWithStatus: async () => ({
      status: "unavailable",
      options: [],
    }),
  };
  const web = {
    isEnabled: () => true,
    searchWithStatus: async () => ({ status: "ok", options: options() }),
  };
  const service = new MedicineSearchOrchestratorService(
    selector,
    {},
    { getRulesForPrinciple: async () => [] },
    primary,
    web,
  );
  const result = await service.searchMedicine("dipirona 1g");
  assert.equal(result.options[0].pricePolicy, WEB_MEDICINE_PRICE_POLICY);
  assert.equal(result.options[0].webQuote.sourceUrl, URL);
});
test("retired paid providers cannot make calls even with old enabled environment values", async (t) => {
  t.mock.method(global, "fetch", () =>
    assert.fail("Retired provider performed HTTP"),
  );
  const cfg = config({
    PHARMADB_ENABLED: true,
    BULAPI_ENABLED: true,
    PHARMADB_API_KEY: "old-key",
  });
  const auth = new PharmaDbAuthService(cfg);
  assert.equal(await auth.getAccessToken(), null);
  assert.equal(
    (await new PharmaDbService(cfg, auth).searchWithStatus("dipirona")).status,
    "disabled",
  );
  assert.equal(
    (await new BulapiCatalogService(cfg, selector).searchWithStatus("dipirona"))
      .status,
    "disabled",
  );
});
test("expired or altered quote cannot be reused at selection", () => {
  const normalized = options()[0];
  const item = {
    ...normalized,
    pricePf: normalized.salePrice,
    pricePolicy: WEB_MEDICINE_PRICE_POLICY,
  };
  assert.equal(validWebQuote(item), true);
  assert.equal(validWebQuote({ ...item, pricePf: 0.01 }), false);
  assert.equal(
    validWebQuote({
      ...item,
      webQuote: { ...item.webQuote, expiresAt: "2020-01-01" },
    }),
    false,
  );
});

function checkoutFixture(revalidate) {
  const option = options()[0];
  const conversation = {
    id: "test",
    customerId: "test",
    pendingAction: State.WAITING_CONFIRMATION,
    lastIntent: null,
    pendingAddress: {
      cep: "88301080",
      logradouro: "Rua Exemplo",
      number: "10",
      bairro: "Centro",
      localidade: "Itajai",
      uf: "SC",
    },
    cart: [
      {
        type: "medicine",
        name: option.displayName,
        medicineName: "dipirona",
        source: "openai_web",
        sourceId: option.sourceId,
        pricePolicy: WEB_MEDICINE_PRICE_POLICY,
        webQuote: option.webQuote,
        quantity: 2,
        unitPrice: 19.9,
        total: 39.8,
      },
    ],
  };
  const calls = [];
  const prisma = {
    conversation: {
      update: async ({ data }) => {
        Object.assign(conversation, data);
        return conversation;
      },
    },
  };
  const engine = new ConversationEngineService(
    prisma,
    {},
    new BulaApiService(config(), selector, {}),
    { findSymptomSuggestion: () => null },
    { isRetailProductQuery: () => false },
    {},
    {
      confirmCheckout: async (input) => {
        calls.push(input);
        return {
          orderId: "test",
          totalCents: 3980,
          pixCopyPaste: "FAKE",
          status: "pending",
        };
      },
    },
    new ConversationInputService(),
    { findCurrentOffer: () => assert.fail("Wrong price source") },
    config(),
    { revalidate, isEnabled: () => true },
  );
  return {
    conversation,
    calls,
    engine,
    send: (text) => engine.resolveReply(conversation, text),
  };
}
test("changed web price requires customer reconfirmation before Pix", async () => {
  const f = checkoutFixture(async () => ({ ...options()[0], salePrice: 25.9 }));
  assert.match(await f.send("1"), /Atualizei os valores/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.conversation.cart[0].total, 51.8);
  await f.send("1");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].cart[0].unitPrice, 25.9);
});
test("unverified checkout never generates Pix and keeps the cart", async () => {
  const f = checkoutFixture(async () => null);
  assert.match(await f.send("1"), /Não gerei cobrança/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.conversation.cart.length, 1);
});
test("wrong product on the same page cannot replace the selected product at checkout", async () => {
  const f = checkoutFixture(async () => ({
    ...options()[0],
    sourceId: "different-package",
  }));
  assert.match(await f.send("1"), /Não gerei cobrança/);
  assert.equal(f.calls.length, 0);
});
