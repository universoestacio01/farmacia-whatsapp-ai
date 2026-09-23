const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Logger } = require("@nestjs/common");
const {
  PrecoPopularService,
} = require("../dist/integrations/preco-popular.service");
const {
  CommercialMedicineSelector,
} = require("../dist/integrations/commercial-medicine-selector");
const {
  MedicineSearchOrchestratorService,
} = require("../dist/integrations/medicine-search-orchestrator.service");
const {
  ProductSearchOrchestratorService,
} = require("../dist/integrations/product-search-orchestrator.service");
const {
  ManualRetailProductService,
} = require("../dist/integrations/manual-retail-product.service");
const {
  ConversationEngineService,
} = require("../dist/whatsapp/conversation-engine.service");
const { HealthController } = require("../dist/health/health.controller");
const {
  DEFAULT_MEDICINE_PRIORITY_RULES,
} = require("../dist/config/medicine-priority-rules.config");
const {
  calculatePrecoPopularSalePrice,
  isPrecoPopularEnabled,
} = require("../dist/config/preco-popular.config");
const { validateEnv } = require("../dist/config/env.validation");
const { BulaApiService } = require("../dist/integrations/bula-api.service");
const { ConversationState } = require("@prisma/client");

Logger.overrideLogger(false);
// This suite must never use real credentials, network, WhatsApp or a database.
global.fetch = async () => {
  throw new Error("Unexpected external request in offline test");
};

const config = (values = {}) => ({ get: (key) => values[key] });
const selector = new CommercialMedicineSelector();
const rules = {
  getRulesForPrinciple: async (principle) =>
    DEFAULT_MEDICINE_PRIORITY_RULES.filter(
      (rule) => rule.principleActive === principle,
    ),
};
const never = async () => {
  assert.fail("Fallback called despite valid primary results");
};

function sku(id, name, price, options = {}) {
  return {
    itemId: String(id),
    name,
    ean: `789000000${String(id).padStart(4, "0")}`,
    images: [{ imageUrl: "https://example.com/product.png" }],
    sellers: [
      {
        sellerDefault: true,
        commertialOffer: { Price: price, AvailableQuantity: 10 },
      },
    ],
    ...options,
  };
}

function product(
  id,
  name,
  price = 20,
  brand = "Venvanse",
  medicine = true,
  options = {},
) {
  return {
    productId: String(id),
    productName: name,
    brand,
    categories: [medicine ? "/Medicamentos/" : "/Higiene/Sabonete/"],
    ...(medicine
      ? {
          "Princípio ativo": [
            brand === "Venvanse" ? "lisdexanfetamina" : "dipirona",
          ],
        }
      : {}),
    items: [sku(id, name, price)],
    ...options,
  };
}

function respond(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function mockFetch(t, response) {
  const calls = [];
  t.mock.method(global, "fetch", async (url, init) => {
    assert.equal(new URL(url).host, "www.precopopular.com.br");
    calls.push({ url: new URL(url), init });
    return response(url, init, calls.length);
  });
  return calls;
}

function medicineSearch(service) {
  return new MedicineSearchOrchestratorService(
    selector,
    { search: never, findSymptomSuggestion: () => null, findSymptomOptions: () => null },
    rules,
    service,
  );
}

function retailSearch(service) {
  const manual = new ManualRetailProductService();
  manual.search = never;
  manual.createManualProduct = never;
  return new ProductSearchOrchestratorService(manual, service);
}

test("full catalog prices are rounded in cents; old discount settings are ignored", () => {
  assert.equal(calculatePrecoPopularSalePrice(100), 100);
  assert.equal(calculatePrecoPopularSalePrice(21.9), 21.9);
  assert.equal(calculatePrecoPopularSalePrice(5.19), 5.19);
  assert.equal(calculatePrecoPopularSalePrice(15.75), 15.75);
  assert.equal(calculatePrecoPopularSalePrice(429.9), 429.9);
  assert.equal(calculatePrecoPopularSalePrice(12.9), 12.9);
  assert.equal(calculatePrecoPopularSalePrice(100, 0.85), 100);
  for (const price of [0, -1, NaN, Infinity])
    assert.throws(() => calculatePrecoPopularSalePrice(price));
});

test("empty brand index retries active ingredient but preserves requested brand", async (t) => {
  const calls = mockFetch(t, (url) => new URL(url).searchParams.get("ft") === "novalgina"
    ? respond([]) : respond([product(1, "Novalgina 1g 10 Comprimidos", 20, "Novalgina"), product(2, "Dipirona 1g 10 Comprimidos", 5, "Generico")]));
  const result = await new PrecoPopularService(config(), selector).searchMedicinesWithStatus("Novalgina 1g");
  assert.deepEqual(calls.map((c) => c.url.searchParams.get("ft")), ["novalgina", "dipirona"]);
  assert.equal(result.options.length, 1);
  assert.match(result.options[0].productName, /Novalgina/);
});

test("simplified query does not replace a combination with a single ingredient", async (t) => {
  const calls = mockFetch(t, (url) => new URL(url).searchParams.get("ft") === "allegra d"
    ? respond([]) : respond([product(1, "Allegra 120mg 10 Comprimidos", 20, "Allegra")]));
  const result = await new PrecoPopularService(config(), selector).searchMedicinesWithStatus("Allegra D");
  assert.equal(result.options.length, 0);
  assert.equal(calls.length, 2);
});

test("provider outage does not trigger broader primary queries", async (t) => {
  const calls = mockFetch(t, () => respond({}, 503));
  const result = await new PrecoPopularService(config(), selector).searchMedicinesWithStatus("Novalgina");
  assert.equal(result.status, "unavailable");
  assert.equal(calls.length, 1);
});

test("enabled by default; lazy construction and disabled switch never fetch", async (t) => {
  const calls = mockFetch(t, never);
  new PrecoPopularService(config(), selector);
  for (const value of [false, "false", "0", '"false"']) {
    const service = new PrecoPopularService(
      config({ PRECO_POPULAR_ENABLED: value }),
      selector,
    );
    assert.equal(service.isEnabled(), false);
    assert.deepEqual(await service.searchMedicines("venvanse"), []);
  }
  assert.equal(isPrecoPopularEnabled(undefined), true);
  assert.equal(calls.length, 0);
});

test("all SKUs preserved, Venvanse 30/50/70 ranked, no manual override or half PMC", async (t) => {
  const doses = [70, 30, 50];
  const catalog = [
    product(1, "Venvanse", 20, "Venvanse", true, {
      items: doses.map((dose) =>
        sku(dose, `Venvanse ${dose}mg Com 28 Capsulas`, 429.9, {
          nameComplete: `Venvanse ${dose}mg Com 28 Capsulas Venvanse ${dose}mg Com 28 Capsulas`,
        }),
      ),
    }),
  ];
  const calls = mockFetch(t, () => respond(catalog));
  const service = new PrecoPopularService(config(), selector);
  const summary = await medicineSearch(service).searchMedicine("Tem Venvanse?");
  assert.equal(summary.options.length, 3);
  assert.deepEqual(summary.options.map((o) => o.strength).sort(), [
    "30mg",
    "50mg",
    "70mg",
  ]);
  for (const option of summary.options) {
    assert.equal(option.pricePf, 429.9);
    assert.equal(option.source, "preco_popular");
    assert.equal(option.formGroup, "capsula");
    assert.equal(option.packageInfo.unitCount, 28);
    assert.equal((option.label.match(/Venvanse/g) || []).length, 1);
    assert.ok(option.imageUrl && option.ean && option.sourceId);
  }
  assert.equal(calls[0].url.searchParams.get("ft"), "venvanse");
});

test("specific Venvanse dose reuses name cache and only returns requested 50mg", async (t) => {
  const calls = mockFetch(t, () =>
    respond(
      [30, 50, 70].map((dose) =>
        product(dose, `Venvanse ${dose}mg Com 28 Capsulas`),
      ),
    ),
  );
  const orchestrator = medicineSearch(
    new PrecoPopularService(config(), selector),
  );
  await orchestrator.searchMedicine("venvanse");
  const selected = await orchestrator.searchMedicine("Venvanse de 50mg");
  assert.equal(selected.options.length, 1);
  assert.equal(selected.options[0].strength, "50mg");
  assert.equal(calls.length, 1);
});

test("1g and 1000mg equivalent; tablets and bottle concentrations stay distinct", async (t) => {
  mockFetch(t, () =>
    respond([
      product(1, "Novalgina Dipirona 1g 10 Comprimidos", 21.9, "Novalgina"),
      product(2, "Dipirona 500mg 10 Comprimidos", 10, "EMS"),
      product(3, "Dipirona 1000mg/ml Gotas 20ml", 10, "EMS"),
    ]),
  );
  const service = new PrecoPopularService(config(), selector);
  const summary =
    await medicineSearch(service).searchMedicine("Dipirona 1000mg");
  assert.equal(summary.options.length, 1);
  assert.equal(summary.options[0].pricePf, 21.9);
  assert.equal(summary.options[0].packageInfo.unitCount, 10);
  assert.match(summary.options[0].label, /1g/);
});

test("brand query does not become a generic substitution", async (t) => {
  mockFetch(t, () =>
    respond([
      product(1, "Novalgina Dipirona 1g 10 Comprimidos", 21.9, "Novalgina"),
      product(2, "Dipirona 1g 10 Comprimidos", 8, "EMS"),
    ]),
  );
  const summary = await medicineSearch(
    new PrecoPopularService(config(), selector),
  ).searchMedicine("Novalgina");
  assert.equal(summary.options.length, 1);
  assert.equal(summary.options[0].brand, "Novalgina");
});

test("retail price/image/EAN preserved; Cosmos and PharmaDB not called", async (t) => {
  mockFetch(t, (url) => {
    assert.match(String(url), /ft=sabonete%20dove/);
    return respond([
      product(1, "Sabonete Dove Original 90g", 5.19, "Dove", false),
    ]);
  });
  const summary = await retailSearch(
    new PrecoPopularService(config(), selector),
  ).searchProducts("sabonete dove");
  assert.equal(summary.manualFallback, false);
  assert.equal(summary.options[0].pricePf, 5.19);
  assert.equal(summary.options[0].source, "preco_popular");
  assert.ok(summary.options[0].imageUrl && summary.options[0].ean);
});

test("EAN query uses exact VTEX filter and does not accept another barcode", async (t) => {
  const match = product(1, "Sabonete Dove 90g", 5.19, "Dove", false);
  const gtin = match.items[0].ean;
  const calls = mockFetch(t, () =>
    respond([match, product(2, "Sabonete Dove 90g", 3, "Dove", false)]),
  );
  const service = new PrecoPopularService(config(), selector);
  const found = await service.findRetailByGtin(gtin);
  assert.equal(found.ean, gtin);
  assert.equal(calls[0].url.searchParams.get("fq"), `alternateIds_Ean:${gtin}`);
  assert.equal(await service.findRetailByGtin("00000000"), null);
});

test("pagination accepts 206, deduplicates EAN and stops a repeated page", async (t) => {
  const page = Array.from({ length: 50 }, (_, id) =>
    product(id + 1, `Venvanse ${id + 1}mg Com 28 Capsulas`),
  );
  const calls = mockFetch(t, () =>
    respond(page, 206, { resources: "0-49/150" }),
  );
  const service = new PrecoPopularService(config(), selector);
  const items = await service.searchMedicines("venvanse");
  assert.equal(items.length, 50);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url.searchParams.get("_from"), "50");
  assert.equal(calls[1].url.searchParams.get("_to"), "99");
  await service.searchMedicines("VENVANSE");
  assert.equal(calls.length, 2);
});

test("concurrent identical queries share one HTTP request", async (t) => {
  const calls = mockFetch(t, async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return respond([product(1, "Venvanse 30mg Com 28 Capsulas")]);
  });
  const service = new PrecoPopularService(config(), selector);
  const results = await Promise.all(
    Array.from({ length: 8 }, () => service.searchMedicines("venvanse")),
  );
  assert.equal(calls.length, 1);
  assert.ok(results.every((items) => items.length === 1));
});

test("missing price, unavailable offers and invalid rows are not sold as valid offers", async (t) => {
  const unavailable = product(2, "Venvanse 50mg Com 28 Capsulas");
  unavailable.items[0].sellers[0].commertialOffer.AvailableQuantity = 0;
  const multiple = product(3, "Venvanse 70mg Com 28 Capsulas", 0);
  multiple.items[0].sellers.push({
    commertialOffer: { Price: 20, AvailableQuantity: 1 },
  });
  mockFetch(t, () =>
    respond([
      null,
      { broken: true },
      product(1, "Venvanse 30mg Com 28 Capsulas", 0),
      unavailable,
      multiple,
    ]),
  );
  const result = await new PrecoPopularService(
    config(),
    selector,
  ).searchMedicines("venvanse");
  assert.equal(result.length, 1);
  assert.equal(result[0].dosage, "70mg");
  assert.equal(result[0].salePrice, 20);
});

test("medicine and retail categories cannot leak into the other flow", async (t) => {
  mockFetch(t, () =>
    respond([
      product(1, "Venvanse 30mg Com 28 Capsulas"),
      product(2, "Sabonete Dove 90g", 5, "Dove", false),
    ]),
  );
  const service = new PrecoPopularService(config(), selector);
  assert.equal((await service.searchMedicines("venvanse")).length, 1);
  assert.equal((await service.searchRetail("sabonete dove")).length, 1);
});

for (const status of [401, 403, 404, 429, 500]) {
  test(`HTTP ${status} is contained and activates cooldown`, async (t) => {
    const calls = mockFetch(t, () => respond({ error: "test" }, status));
    const service = new PrecoPopularService(config(), selector);
    assert.deepEqual(await service.searchMedicines("venvanse"), []);
    assert.deepEqual(await service.searchRetail("sabonete dove"), []);
    assert.equal(calls.length, 1);
  });
}

test("unexpected JSON and transport errors return empty results safely", async (t) => {
  let calls = 0;
  mockFetch(t, () => {
    if (++calls === 1) return respond({ error: "wrong shape" });
    throw new Error("network offline");
  });
  assert.deepEqual(
    await new PrecoPopularService(config(), selector).searchMedicines(
      "venvanse",
    ),
    [],
  );
  assert.deepEqual(
    await new PrecoPopularService(config(), selector).searchMedicines(
      "venvanse",
    ),
    [],
  );
});

test("8-second timeout aborts request without uncaught rejection", async (t) => {
  const timeouts = [];
  const realSetTimeout = global.setTimeout;
  t.mock.method(global, "setTimeout", (callback, ms, ...args) => {
    timeouts.push(ms);
    return realSetTimeout(callback, ms === 8000 ? 5 : ms, ...args);
  });
  mockFetch(
    t,
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      }),
  );
  const result = await new PrecoPopularService(
    config(),
    selector,
  ).searchMedicines("venvanse");
  assert.deepEqual(result, []);
  assert.ok(timeouts.includes(8000));
});

for (const status of [200, 401, 429, 500]) {
  test(`empty/failed sole catalog HTTP ${status} never uses old providers or manual prices`, async (t) => {
    const calls = mockFetch(t, () => respond(status === 200 ? [] : {}, status));
    const catalog = new PrecoPopularService(config({ MEDICINE_PRIMARY_PROVIDER: "pharmadb" }), selector);
    assert.deepEqual((await medicineSearch(catalog).searchMedicine("venvanse")).options, []);
    const retail = await retailSearch(catalog).searchProducts("sabonete dove");
    assert.deepEqual(retail.options, []);
    assert.equal(retail.manualFallback, false);
    assert.ok(calls.every((call) => call.url.host === "www.precopopular.com.br"));
  });
}

test("any brand uses real catalog offers, never fabricated category prices", async (t) => {
  const calls = mockFetch(t, () => respond([product(1, "Shampoo Seda 325ml", 23.49, "Seda", false)]));
  const summary = await retailSearch(new PrecoPopularService(config(), selector)).searchProducts("shampoo");
  assert.equal(calls.length, 1);
  assert.equal(summary.manualFallback, false);
  assert.equal(summary.options[0].pricePf, 23.49);
});

test("legacy multiplier 0.9 does not discount medicine or retail", async (t) => {
  mockFetch(t, () => respond([
    product(1, "Venvanse 30mg Com 28 Capsulas", 429.9),
    product(2, "Sabonete Dove 90g", 5.19, "Dove", false),
  ]));
  const catalog = new PrecoPopularService(config({ PRECO_POPULAR_PRICE_MULTIPLIER: 0.9 }), selector);
  assert.equal((await catalog.searchMedicines("venvanse"))[0].salePrice, 429.9);
  assert.equal((await catalog.searchRetail("sabonete dove"))[0].salePrice, 5.19);
});

test("retired BulAPI HTTP transport is blocked even on accidental direct use", async (t) => {
  const calls = mockFetch(t, never);
  const bula = new BulaApiService(config(), selector, rules);
  assert.equal(await bula.lookupMedicine("dipirona"), null);
  assert.equal(calls.length, 0);
});

test("mixed cart preserves final price, image, EAN and subtotal without discounting twice", async (t) => {
  mockFetch(t, (url) =>
    new URL(url).searchParams.get("ft") === "venvanse"
      ? respond([product(1, "Venvanse 30mg Com 28 Capsulas", 429.9)])
      : respond([
          product(2, "Sabonete Dove Original 90g", 5.19, "Dove", false),
        ]),
  );
  const service = new PrecoPopularService(config(), selector);
  const medicine = (await medicineSearch(service).searchMedicine("venvanse"))
    .options[0];
  const retail = (await retailSearch(service).searchProducts("sabonete dove"))
    .options[0];
  const engine = Object.create(ConversationEngineService.prototype);
  const cart = [
    engine.buildCartItem(medicine, 1),
    engine.buildCartItem(retail, 2),
  ];
  assert.equal(cart[0].unitPrice, 429.9);
  assert.equal(cart[1].unitPrice, 5.19);
  assert.equal(cart[1].total, 10.38);
  assert.ok(Math.abs(engine.cartSubtotal(cart) - 440.28) < 0.00001);
  assert.deepEqual(
    cart.map((item) => item.type),
    ["medicine", "retail_product"],
  );
  assert.ok(
    cart.every(
      (item) => item.imageUrl && item.ean && item.source === "preco_popular",
    ),
  );
});

test("health is config-only, exposes primary catalog and lazy medicine backups without fetching", () => {
  const health = new HealthController(
    config({ MEDICINE_PRIMARY_PROVIDER: "pharmadb", OPENAI_API_KEY: "test-key" }),
    {},
  );
  const result = health.providers();
  assert.equal(result.primaryProvider, "preco_popular");
  assert.equal(result.medicineFallbackProvider, "openai_web");
  assert.equal(result.connectivityChecked, false);
  assert.equal(result.retailPrimaryProvider, "preco_popular");
  assert.equal(result.providers.preco_popular.priceMultiplier, 1);
  assert.equal(result.providers.preco_popular.lazy, true);
  for (const provider of ["cosmos", "pharmadb", "bulapi"]) {
    assert.equal(result.providers[provider].enabled, false);
    assert.equal(result.providers[provider].retired, true);
  }
  assert.equal(result.providers.openai_web.enabled, true);
  const disabled = new HealthController(
    config({ PRECO_POPULAR_ENABLED: false }),
    {},
  ).providers();
  assert.equal(disabled.primaryProvider, null);
});

test("environment validation defaults new provider on, with multiplier 1", () => {
  const required = {
    DATABASE_URL: "mysql://test:test@localhost/test",
    WHATSAPP_ACCESS_TOKEN: "offline",
    WHATSAPP_PHONE_NUMBER_ID: "offline",
    WHATSAPP_VERIFY_TOKEN: "offline",
    WHATSAPP_APP_SECRET: "offline",
  };
  const env = validateEnv(required);
  assert.equal(env.PRECO_POPULAR_ENABLED, true);
  assert.equal(env.PRECO_POPULAR_PRICE_MULTIPLIER, 1);
  assert.equal(
    validateEnv({ ...required, PRECO_POPULAR_ENABLED: "false" })
      .PRECO_POPULAR_ENABLED,
    false,
  );
  assert.equal(validateEnv({ ...required, PRECO_POPULAR_PRICE_MULTIPLIER: 0.9 }).PRECO_POPULAR_PRICE_MULTIPLIER, 1);
});

test("real conversation engine: dosage change, mixed cart, address and checkout use full catalog amount", async (t) => {
  const calls = mockFetch(t, (url) =>
    new URL(url).searchParams.get("ft") === "venvanse"
      ? respond(
          [30, 50, 70].map((dose) =>
            product(dose, `Venvanse ${dose}mg Com 28 Capsulas`, 429.9),
          ),
        )
      : respond([
          product(2, "Sabonete Dove Original 90g", 5.19, "Dove", false),
        ]),
  );
  const service = new PrecoPopularService(config(), selector);
  const conversation = {
    id: "offline-conversation",
    customerId: "offline-customer",
    pendingAction: ConversationState.IDLE,
    lastIntent: null,
    lastMedicine: null,
    currentMedicineQuery: null,
    currentRetailCategory: null,
    candidateOptions: null,
    selectedPresentation: null,
    cart: null,
    pendingAddress: null,
  };
  const prisma = {
    conversation: {
      update: async ({ data }) => Object.assign(conversation, data),
    },
  };
  const bula = new BulaApiService(config(), selector, rules);
  bula.priceSelectedOption = never;
  const checkouts = [];
  const engine = new ConversationEngineService(
    prisma,
    { generatePharmacyReply: never },
    bula,
    medicineSearch(service),
    retailSearch(service),
    {
      findAddressByCep: async (cep) => ({
        cep,
        logradouro: "Rua Teste",
        bairro: "Centro",
        localidade: "Itajai",
        uf: "SC",
      }),
    },
    {
      confirmCheckout: async (input) => {
        checkouts.push(input);
        return {
          orderId: "offline-order",
          totalCents: Math.round(
            input.cart.reduce((sum, item) => sum + item.total, 0) * 100,
          ),
          pixCopyPaste: "000201OFFLINE",
          provider: "pix_direct",
          status: "pending",
        };
      },
    },
  );
  const send = async (message) => engine.resolveReply(conversation, message);
  const opening = await send("Olá, Gostaria de fazer um pedido");
  assert.match(opening, /Qual medicamento ou produto/);
  assert.equal(calls.length, 0, "Opening without a product must not query any catalog");
  const initialOptions = await send("Tem Venvanse?");
  assert.match(initialOptions, /429,90/);
  assert.equal((initialOptions.match(/28/g) || []).length, 3);
  assert.equal(conversation.candidateOptions.length, 3);
  await send("Tem de 50mg?");
  assert.equal(conversation.selectedPresentation.strength, "50mg");
  assert.equal(conversation.selectedPresentation.pricePf, 429.9);
  await send("1");
  await send("adicionar mais");
  await send("Tem sabonete Dove?");
  assert.equal(conversation.selectedPresentation.pricePf, 5.19);
  await send("2");
  const cartReply = await send("ver carrinho");
  assert.match(cartReply, /440,28/);
  assert.equal(conversation.cart.length, 2);
  await send("finalizar");
  await send("01001000");
  await send("123");
  const summary = await send("nao");
  assert.match(summary, /440,28/);
  const pix = await send("1");
  assert.equal(checkouts.length, 1);
  assert.equal(checkouts[0].cart[0].unitPrice, 429.9);
  assert.equal(checkouts[0].cart[1].unitPrice, 5.19);
  assert.equal(conversation.pendingAction, ConversationState.WAITING_PIX);
  assert.match(pix[0], /440,28/);
  assert.equal(calls.length, 2);
});

test("Nest module registers and injects new provider without network or database on init", async (t) => {
  const { Test } = require("@nestjs/testing");
  const { ConfigModule } = require("@nestjs/config");
  const {
    IntegrationsModule,
  } = require("../dist/integrations/integrations.module");
  const { PrismaService } = require("../dist/prisma/prisma.service");
  const calls = mockFetch(t, never);
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        ignoreEnvVars: true,
      }),
      IntegrationsModule,
    ],
  })
    .overrideProvider(PrismaService)
    .useValue({ safePrismaCall: never })
    .compile();
  try {
    await module.init();
    const service = module.get(PrecoPopularService);
    for (const [path, name] of [
      ["openai-web-medicine.service", "OpenAiWebMedicineService"],
    ]) {
      assert.ok(module.get(require(`../dist/integrations/${path}`)[name]));
    }
    for (const [path, name] of [
      ["cosmos.service", "CosmosService"],
      ["pharmadb.service", "PharmaDbService"],
      ["bulapi-catalog.service", "BulapiCatalogService"],
      ["cosmos-token-pool.service", "CosmosTokenPoolService"],
    ]) {
      const retired = require(`../dist/integrations/${path}`)[name];
      assert.throws(() => module.get(retired), /does not exist/);
    }
    assert.equal(
      module.get(MedicineSearchOrchestratorService).precoPopularService,
      service,
    );
    assert.equal(
      module.get(ProductSearchOrchestratorService).precoPopularService,
      service,
    );
    assert.equal(calls.length, 0);
  } finally {
    await module.close();
  }
});
