const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Logger } = require("@nestjs/common");
const { ConversationState: State, Prisma } = require("@prisma/client");
const {
  PharmaDbAuthService,
} = require("../dist/integrations/pharmadb-auth.service");
const { PharmaDbService } = require("../dist/integrations/pharmadb.service");
const {
  BulapiCatalogService,
} = require("../dist/integrations/bulapi-catalog.service");
const {
  MedicineSearchOrchestratorService,
} = require("../dist/integrations/medicine-search-orchestrator.service");
const {
  CommercialMedicineSelector,
} = require("../dist/integrations/commercial-medicine-selector");
const {
  ConversationEngineService,
} = require("../dist/whatsapp/conversation-engine.service");
const { BulaApiService } = require("../dist/integrations/bula-api.service");
const {
  ConversationInputService,
} = require("../dist/whatsapp/conversation-input.service");
const { HealthController } = require("../dist/health/health.controller");
const { validateEnv } = require("../dist/config/env.validation");
const {
  backupPricePolicy,
  hasBackupPrice,
} = require("../dist/config/medicine-backups.config");
const { CATALOG_PRICE_POLICY } = require("../dist/config/preco-popular.config");

Logger.overrideLogger(false);
const never = () => assert.fail("Unexpected external call");
global.fetch = never;

test("BulAPI price budget preserves 30/50/70mg instead of two packages of 30mg", async (t) => {
  const calls = mockHttp(t, (url) => {
    if (url.pathname.endsWith("/search")) return { data: { products: [{ id: 1, name: "Venvanse" }] } };
    if (url.pathname.includes("/products/")) return { data: [
      { id: 11, strength: "30mg", dose_form: "capsula", package_description: "CT FR X 28" },
      { id: 12, strength: "30 mg", dose_form: "capsula", package_description: "CT FR X 30" },
      { id: 13, strength: "50mg", dose_form: "capsula", package_description: "CT FR X 28" },
      { id: 14, strength: "70mg", dose_form: "capsula", package_description: "CT FR X 28" },
    ] };
    return { data: [{ pf_prices: { pf: 100 } }] };
  });
  const result = await new BulapiCatalogService(config(), selector).searchWithStatus("venvanse");
  assert.deepEqual(result.options.map((o) => o.dosage), ["30mg", "50mg", "70mg"]);
  assert.equal(calls.length, 5);
});
const selector = new CommercialMedicineSelector();
const config = (values = {}) => ({ get: (key) => values[key] });
const option = (overrides = {}) => ({
  source: "pharmadb",
  sourceId: "p:1",
  productName: "Dipirona",
  displayName: "Dipirona",
  substance: "dipirona",
  dosage: "500mg",
  form: "comprimido",
  priceFactory: 12.34,
  presentation: "500 MG COM CT BL X 10",
  availabilityStatus: "unknown",
  ...overrides,
});
function provider(name, result, calls, enabled = true) {
  return {
    name,
    isEnabled: () => enabled,
    searchWithStatus: async () => {
      calls.push(name);
      return structuredClone(result);
    },
  };
}
function flow({
  primary = { options: [], status: "ok" },
  pharma = { options: [option()], status: "ok" },
  bula = { options: [], status: "ok" },
  values = {},
  pharmaEnabled = true,
  bulaEnabled = true,
} = {}) {
  const calls = [];
  const logs = [];
  const service = new MedicineSearchOrchestratorService(
    selector,
    {},
    { getRulesForPrinciple: async () => [] },
    {
      isEnabled: () => true,
      searchMedicinesWithStatus: async () => {
        calls.push("primary");
        return primary;
      },
    },
    provider("pharmadb", pharma, calls, pharmaEnabled),
    provider("bulapi", bula, calls, bulaEnabled),
    config(values),
    { record: async (entry) => logs.push(entry) },
  );
  return { service, calls, logs };
}
function mockHttp(t, handler) {
  const calls = [];
  t.mock.method(global, "fetch", async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const result = await handler(new URL(url), options, calls.length);
    return new Response(JSON.stringify(result.body ?? result), {
      status: result.status || 200,
    });
  });
  return calls;
}
const pharmaConfig = () => config({ PHARMADB_API_KEY: "offline-key" });
function pharmaService(values = pharmaConfig()) {
  return new PharmaDbService(values, new PharmaDbAuthService(values), selector);
}
const pharmaDetail = (presentations) => ({
  id: 1,
  nome: "Dipirona",
  comercializado: true,
  apresentacoes: presentations,
});
const pharmaPresentation = (overrides = {}) => ({
  id: 1,
  descricao: "500 MG COM CT BL X 10",
  pf_0: 1234,
  pmc_0: 3000,
  ...overrides,
});

test("primary success uses full catalog price and never touches backups", async () => {
  const f = flow({
    primary: {
      status: "ok",
      options: [option({ source: "preco_popular", salePrice: 27.9 })],
    },
  });
  const result = await f.service.searchMedicine("dipirona");
  assert.deepEqual(f.calls, ["primary"]);
  assert.equal(result.options[0].pricePf, 27.9);
  assert.equal(result.options[0].pricePolicy, CATALOG_PRICE_POLICY);
});

test("primary failure uses PharmaDB PF, not PMC or 10 percent discount", async () => {
  const f = flow({
    primary: { status: "unavailable", options: [] },
    pharma: { status: "ok", options: [option({ priceConsumer: 40 })] },
  });
  const result = await f.service.searchMedicine("dipirona");
  assert.deepEqual(f.calls, ["primary", "pharmadb"]);
  assert.equal(result.options[0].pricePf, 12.34);
  assert.equal(result.options[0].pricePolicy, "pharmadb_pf_or_pmc_v1:0.5");
  assert.equal(result.options[0].formGroup, "comprimido");
  assert.equal(result.options[0].packageInfo.unitCount, 10);
  assert.equal(f.logs[0].provider, "pharmadb");
});

for (const [name, values, fields, expected] of [
  ["default half PMC", {}, { priceConsumer: 39.99 }, 20],
  ["ICMS PMC first", {}, { pmcWithIcms: 50, priceConsumer: 40 }, 25],
  [
    "custom factor",
    { PHARMADB_PMC_PRICE_MULTIPLIER: "0.6" },
    { priceConsumer: 40 },
    24,
  ],
])
  test(`PharmaDB price: ${name}`, async () => {
    const f = flow({
      values,
      pharma: {
        status: "ok",
        options: [option({ priceFactory: undefined, ...fields })],
      },
    });
    assert.equal(
      (await f.service.searchMedicine("dipirona")).options[0].pricePf,
      expected,
    );
  });

test("PharmaDB unavailable proceeds to BulAPI, keeping its PF", async () => {
  const f = flow({
    pharma: { status: "unavailable", options: [] },
    bula: {
      status: "ok",
      options: [option({ source: "bulapi", priceFactory: 19.9 })],
    },
  });
  const result = await f.service.searchMedicine("dipirona");
  assert.deepEqual(f.calls, ["primary", "pharmadb", "bulapi"]);
  assert.equal(result.options[0].pricePf, 19.9);
  assert.equal(result.options[0].pricePolicy, "bulapi_max_pf_v1");
});

test("both failures are unavailable, not a false product absence", async () => {
  const f = flow({
    pharma: { status: "unavailable", options: [] },
    bula: { status: "unavailable", options: [] },
  });
  assert.equal(
    (await f.service.searchMedicine("dipirona")).searchStatus,
    "unavailable",
  );
});

test("retail handoff never calls medicine backups", async () => {
  const f = flow({
    primary: {
      status: "ok",
      options: [],
      retailFallbackQuery: "soro fisiologico",
    },
  });
  assert.equal(
    (await f.service.searchMedicine("soro fisiologico")).retailFallbackQuery,
    "soro fisiologico",
  );
  assert.deepEqual(f.calls, ["primary"]);
});

test("disabled backups and primary negative do not fabricate offers", async () => {
  const f = flow({ pharmaEnabled: false, bulaEnabled: false });
  assert.equal(
    (await f.service.searchMedicine("dipirona")).searchStatus,
    "not_found",
  );
  assert.deepEqual(f.calls, ["primary"]);
});

test("missing or zero price cannot enter a sale even if product exists", async () => {
  const f = flow({
    pharma: { status: "ok", options: [option({ priceFactory: 0 })] },
    bula: {
      status: "ok",
      options: [
        option({
          source: "bulapi",
          priceFactory: undefined,
          priceConsumer: 99,
        }),
      ],
    },
  });
  const result = await f.service.searchMedicine("dipirona");
  assert.equal(result.options.length, 0);
  assert.equal(result.searchStatus, "offer_unavailable");
});

for (const [name, query, changes] of [
  ["wrong strength", "dipirona 1g", {}],
  [
    "concentration not mass",
    "dipirona 500mg",
    { dosage: "500mg/ml", presentation: "500MG/ML SOL OR FR GOT X 20ML" },
  ],
  ["wrong form", "dipirona gotas", {}],
  ["wrong count", "dipirona com 30 comprimidos", {}],
  ["inactive", "dipirona", { availabilityStatus: "inactive" }],
  ["out of stock", "dipirona", { availabilityStatus: "out_of_stock" }],
  ["injectable", "dipirona", { presentation: "500MG/ML SOL INJ X 10ML" }],
  ["hospital", "dipirona", { presentation: "500MG COM X 10 USO HOSPITALAR" }],
  [
    "missing dose",
    "dipirona",
    { dosage: undefined, presentation: "COM CT X 10" },
  ],
  ["unknown form", "dipirona", { form: undefined, presentation: "500MG" }],
  ["quarantined EAN", "dipirona", { ean: "7891058003555" }],
  [
    "other medicine",
    "dipirona",
    { productName: "Ibuprofeno", substance: "ibuprofeno" },
  ],
])
  test(`backup rejects ${name}`, async () => {
    const f = flow({ pharma: { status: "ok", options: [option(changes)] } });
    assert.equal((await f.service.searchMedicine(query)).options.length, 0);
  });

test("equivalent gram dose accepted and cache remains dose-specific", async () => {
  const f = flow({
    pharma: {
      status: "ok",
      options: [
        option(),
        option({
          sourceId: "p:2",
          dosage: "1000mg",
          presentation: "1000 MG COM CT X 10",
        }),
      ],
    },
  });
  const first = await f.service.searchMedicine("dipirona 1g");
  assert.equal(first.options.length, 1);
  assert.equal(first.options[0].strength, "1000mg");
  const second = await f.service.searchMedicine("dipirona 500mg");
  assert.equal(second.options.length, 1);
  assert.equal(second.options[0].strength, "500mg");
});

test("brand strengths remain distinct and no automatic dosage substitution", async () => {
  const options = [30, 30, 50, 70].map((mg, i) =>
    option({
      productName: "Venvanse",
      substance: "lisdexanfetamina",
      sourceId: `v:${i}`,
      dosage: `${mg}mg`,
      presentation: `${mg} MG CAP DURA CT FR X 28`,
    }),
  );
  const f = flow({ pharma: { status: "ok", options } });
  assert.deepEqual(
    (await f.service.searchMedicine("venvanse")).options
      .map((o) => o.strength)
      .sort(),
    ["30mg", "50mg", "70mg"],
  );
  const exact = await f.service.searchMedicine("venvanse 70mg");
  assert.equal(exact.options.length, 1);
  assert.equal(exact.options[0].strength, "70mg");
});

test("auth is lazy, sanitizes quotes, caches and groups concurrent requests", async (t) => {
  const calls = mockHttp(t, () => ({
    access_token: "offline-token",
    expires_in: 3600,
  }));
  const auth = new PharmaDbAuthService(
    config({ PHARMADB_API_KEY: '  "offline-key"  ' }),
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(
    await Promise.all([auth.getAccessToken(), auth.getAccessToken()]),
    ["offline-token", "offline-token"],
  );
  assert.equal(await auth.getAccessToken(), "offline-token");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers["x-api-key"], "offline-key");
  assert.equal(calls[0].options.redirect, "error");
});

for (const status of [401, 429, 502])
  test(`PharmaDB auth ${status} pauses subsequent lookups`, async (t) => {
    const calls = mockHttp(t, () => ({ status, body: {} }));
    const service = pharmaService();
    assert.equal(
      (await service.searchWithStatus("dipirona")).status,
      "unavailable",
    );
    assert.equal(
      (await service.searchWithStatus("ibuprofeno")).status,
      "unavailable",
    );
    assert.equal(calls.length, 1);
  });

test("PharmaDB parses cents, exact presentation, caches and groups same-name lookups", async (t) => {
  const calls = mockHttp(t, (url) =>
    url.pathname === "/auth/token"
      ? { access_token: "offline", expires_in: 3600 }
      : url.pathname.endsWith("/busca")
        ? {
            items: [{ id: 1, nome: "Dipirona" }],
            total: 1,
            page: 1,
            per_page: 100,
          }
        : pharmaDetail([
            pharmaPresentation(),
            pharmaPresentation({
              id: 2,
              descricao: "1 G COM CT X 10",
              pf_0: null,
              pmc_0: 4000,
            }),
          ]),
  );
  const service = pharmaService();
  const [a, b] = await Promise.all([
    service.searchWithStatus("dipirona 500mg"),
    service.searchWithStatus("dipirona 1g"),
  ]);
  assert.equal(a.status, "ok");
  assert.deepEqual(a, b);
  assert.equal(a.options[0].priceFactory, 12.34);
  assert.equal(a.options[1].priceConsumer, 40);
  assert.equal(a.options[1].dosage, "1g");
  await service.searchWithStatus("dipirona");
  assert.equal(calls.length, 3);
});

test("PharmaDB refreshes 401 once; second 401 fails and is not cached as empty", async (t) => {
  const calls = mockHttp(t, (url) =>
    url.pathname === "/auth/token"
      ? { access_token: "offline", expires_in: 3600 }
      : { status: 401, body: {} },
  );
  const service = pharmaService();
  assert.equal(
    (await service.searchWithStatus("dipirona")).status,
    "unavailable",
  );
  assert.equal(calls.length, 4);
  assert.equal(
    (await service.searchWithStatus("novalgina")).status,
    "unavailable",
  );
  assert.equal(calls.length, 4);
});

for (const failure of ["malformed_search", "detail_error"])
  test(`PharmaDB ${failure} is API failure, not absence`, async (t) => {
    mockHttp(t, (url) =>
      url.pathname === "/auth/token"
        ? { access_token: "offline" }
        : url.pathname.endsWith("/busca")
          ? failure === "malformed_search"
            ? { unexpected: true }
            : { items: [{ id: 1, nome: "Dipirona" }] }
          : { status: 503, body: {} },
    );
    assert.equal(
      (await pharmaService().searchWithStatus("dipirona")).status,
      "unavailable",
    );
  });

test("PharmaDB uses page 2 but caps detail expansion and preserves inactive status", async (t) => {
  const calls = mockHttp(t, (url) => {
    if (url.pathname === "/auth/token") return { access_token: "offline" };
    if (url.pathname.endsWith("/busca")) {
      const page = Number(url.searchParams.get("page"));
      return {
        items: Array.from({ length: 100 }, (_, i) => ({
          id: (page - 1) * 100 + i + 1,
          nome: page === 1 ? "Outro" : "Dipirona",
        })),
        total: 400,
        page,
        per_page: 100,
      };
    }
    return { ...pharmaDetail([pharmaPresentation()]), comercializado: false };
  });
  const result = await pharmaService().searchWithStatus("dipirona");
  assert.equal(result.options.length, 3);
  assert.equal(result.status, "incomplete");
  assert.ok(result.options.every((o) => o.availabilityStatus === "inactive"));
  assert.equal(calls.filter((c) => c.url.includes("/busca")).length, 2);
  assert.equal(calls.length, 6);
});

test("PharmaDB follows explicit pagination even when provider returns fewer than requested 100 items", async (t) => {
  const calls = mockHttp(t, (url) => {
    if (url.pathname === "/auth/token") return { access_token: "offline" };
    if (url.pathname.endsWith("/busca")) {
      const page = Number(url.searchParams.get("page"));
      return {
        items: [{ id: page, nome: page === 1 ? "Outro" : "Dipirona" }],
        total: 2,
        page,
        per_page: 1,
      };
    }
    return pharmaDetail([pharmaPresentation()]);
  });
  const result = await pharmaService().searchWithStatus("dipirona");
  assert.equal(result.options.length, 1);
  assert.equal(result.status, "ok");
  assert.equal(calls.length, 4);
});

test("search limit does not turn a missing presentation into a definitive absence", async () => {
  const f = flow({ pharma: { status: "incomplete", options: [] } });
  assert.equal(
    (await f.service.searchMedicine("dipirona 1g")).searchStatus,
    "incomplete",
  );
});

test("PharmaDB repeated pages are bounded and marked incomplete", async (t) => {
  const calls = mockHttp(t, (url) =>
    url.pathname === "/auth/token"
      ? { access_token: "offline" }
      : url.pathname.endsWith("/busca")
        ? {
            items: [{ id: 1, nome: "Dipirona" }],
            total: 100,
            page: 1,
            per_page: 1,
          }
        : pharmaDetail([pharmaPresentation()]),
  );
  const result = await pharmaService().searchWithStatus("dipirona");
  assert.equal(result.status, "incomplete");
  assert.equal(result.options.length, 1);
  assert.equal(calls.length, 4);
});

test("successful empty searches are cached but expire and allow another lookup", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const calls = mockHttp(t, (url) =>
    url.pathname === "/auth/token"
      ? { access_token: "offline" }
      : { items: [] },
  );
  const service = pharmaService();
  assert.equal((await service.searchWithStatus("dipirona")).status, "ok");
  await service.searchWithStatus("dipirona");
  assert.equal(calls.length, 2);
  now += 61_000;
  await service.searchWithStatus("dipirona");
  assert.equal(calls.length, 3);
});

test("PharmaDB cooldown expires after authentication failure", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const calls = mockHttp(t, () => ({ status: 401, body: {} }));
  const service = pharmaService();
  await service.searchWithStatus("dipirona");
  await service.searchWithStatus("novalgina");
  assert.equal(calls.length, 1);
  now += 61_000;
  await service.searchWithStatus("dipirona");
  assert.equal(calls.length, 2);
});

test("BulAPI fetches exact presentation prices and selects largest PF", async (t) => {
  const calls = mockHttp(t, (url) => {
    if (url.pathname.endsWith("/search"))
      return { data: { products: [{ id: 1, name: "Dipirona" }] } };
    if (url.pathname.includes("/products/"))
      return {
        data: [
          {
            id: 11,
            strength: "500mg",
            dose_form: "comprimido",
            package_description: "caixa com 10 comprimidos",
          },
          {
            id: 12,
            strength: "1g",
            dose_form: "comprimido",
            package_description: "caixa com 10 comprimidos",
          },
        ],
      };
    assert.ok(url.pathname.includes("/12/"));
    return {
      data: [
        {
          pf_prices: { pf_0: "20.12", pf_18: "24.50" },
          pmc_prices: { pmc_18: 70 },
        },
      ],
    };
  });
  const service = new BulapiCatalogService(config(), selector);
  const [a, b] = await Promise.all([
    service.searchWithStatus("dipirona 1g"),
    service.searchWithStatus("dipirona 1g"),
  ]);
  assert.equal(a.status, "ok");
  assert.deepEqual(a, b);
  assert.equal(a.options.length, 1);
  assert.equal(a.options[0].priceFactory, 24.5);
  await service.searchWithStatus("dipirona 1g");
  assert.equal(calls.length, 3);
});

test("BulAPI 502 pauses requests and disabled flag makes no request", async (t) => {
  const calls = mockHttp(t, () => ({ status: 502, body: {} }));
  const service = new BulapiCatalogService(config(), selector);
  assert.equal(
    (await service.searchWithStatus("dipirona")).status,
    "unavailable",
  );
  assert.equal(
    (await service.searchWithStatus("novalgina")).status,
    "unavailable",
  );
  assert.equal(
    (
      await new BulapiCatalogService(
        config({ BULAPI_ENABLED: false }),
        selector,
      ).searchWithStatus("dipirona")
    ).status,
    "disabled",
  );
  assert.equal(calls.length, 1);
});

test("BulAPI limits requests and handles presentation pagination without claiming exhaustive search", async (t) => {
  const calls = mockHttp(t, (url) => {
    if (url.pathname.endsWith("/search"))
      return {
        data: {
          products: [1, 2, 3, 4].map((id) => ({ id, name: "Dipirona" })),
        },
      };
    if (url.pathname.includes("/products/")) {
      const page = Number(url.searchParams.get("page"));
      return {
        data: [1, 2, 3].map((id) => ({
          id: page * 100 + id,
          strength: `${id * 500}mg`,
          dose_form: "comprimido",
          package_description: "CT X 10",
        })),
        meta: { last_page: 5 },
      };
    }
    return { data: [{ pf_prices: { pf: 12 } }] };
  });
  const result = await new BulapiCatalogService(
    config(),
    selector,
  ).searchWithStatus("dipirona");
  assert.equal(result.options.length, 3);
  assert.equal(result.status, "incomplete");
  assert.equal(calls.length, 9);
  assert.ok(calls.every((call) => !call.url.includes("page=3")));
});

test("BulAPI preserves compound concentration rather than accepting just its first component", async () => {
  const f = flow({
    pharmaEnabled: false,
    bula: {
      status: "ok",
      options: [
        option({
          source: "bulapi",
          productName: "Dorflex",
          substance: "dipirona + orfenadrina + cafeina",
          dosage: "300mg + 35mg + 50mg",
          presentation: "300mg + 35mg + 50mg COM X 10",
        }),
      ],
    },
  });
  assert.equal(
    (await f.service.searchMedicine("dorflex 300mg")).options.length,
    0,
  );
});

test("health exposes configured backups, not verified health or secret values", () => {
  const result = new HealthController(
    config({
      PHARMADB_API_KEY: "DO_NOT_EXPOSE",
      PHARMADB_PMC_PRICE_MULTIPLIER: 0.5,
    }),
    {},
  ).providers();
  assert.deepEqual(result.medicineFallbackProviders, ["pharmadb", "bulapi"]);
  assert.equal(result.connectivityChecked, false);
  assert.equal(result.providers.cosmos.retired, true);
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_EXPOSE/);
});

test("GET /health/providers is actually registered in Nest and makes no provider calls", async () => {
  const { Test } = require("@nestjs/testing");
  const { ConfigService } = require("@nestjs/config");
  const http = require("node:http");
  const module = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      {
        provide: ConfigService,
        useValue: config({ PHARMADB_API_KEY: "offline" }),
      },
    ],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  try {
    await app.listen(0, "127.0.0.1");
    const url = `${await app.getUrl()}/health/providers`;
    const response = await new Promise((resolve, reject) =>
      http
        .get(url, (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () =>
            resolve({ status: res.statusCode, body: JSON.parse(body) }),
          );
          res.on("error", reject);
        })
        .on("error", reject),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.medicineFallbackProviders, [
      "pharmadb",
      "bulapi",
    ]);
    assert.equal(response.body.connectivityChecked, false);
  } finally {
    await app.close();
  }
});

test("env validation preserves backup settings and defaults without leaking or accepting HTTP", () => {
  const env = {
    DATABASE_URL: "mysql://user:pass@localhost/db",
    WHATSAPP_ACCESS_TOKEN: "offline",
    WHATSAPP_PHONE_NUMBER_ID: "1",
    WHATSAPP_VERIFY_TOKEN: "offline",
    WHATSAPP_APP_SECRET: "offline",
    PHARMADB_API_KEY: ' "offline-key" ',
  };
  const result = validateEnv(env);
  assert.equal(result.PHARMADB_API_KEY, "offline-key");
  assert.equal(result.PHARMADB_ENABLED, true);
  assert.equal(result.BULAPI_ENABLED, true);
  assert.equal(result.PHARMADB_PMC_PRICE_MULTIPLIER, 0.5);
  assert.equal(
    validateEnv({ ...env, BULAPI_ENABLED: "false" }).BULAPI_ENABLED,
    false,
  );
  assert.throws(
    () =>
      validateEnv({ ...env, PHARMADB_API_BASE_URL: "http://example.test/v1" }),
    /PHARMADB_API_BASE_URL/,
  );
});

for (const source of ["pharmadb", "bulapi"])
  test(`${source} price survives selection, cart and checkout without primary relookup`, async () => {
    const f = flow({
      pharmaEnabled: source === "pharmadb",
      pharma: { status: "ok", options: [option()] },
      bula: { status: "ok", options: [option({ source: "bulapi" })] },
    });
    const selected = (await f.service.searchMedicine("dipirona 500mg"))
      .options[0];
    const conversation = {
      id: "offline",
      customerId: "offline",
      cart: [],
      candidateOptions: [selected],
      pendingAction: State.WAITING_MEDICINE_OPTION,
      currentMedicineQuery: "dipirona",
      lastMedicine: "dipirona",
      selectedPresentation: null,
      lastIntent: null,
    };
    const prisma = {
      conversation: {
        update: async ({ data }) => {
          for (const [key, value] of Object.entries(data))
            conversation[key] = value === Prisma.JsonNull ? null : value;
          return conversation;
        },
      },
    };
    const orders = [];
    const engine = new ConversationEngineService(
      prisma,
      {},
      new BulaApiService(config(), selector, {}),
      { findSymptomSuggestion: () => null },
      { isRetailProductQuery: () => false },
      {},
      {
        confirmCheckout: async (input) => {
          orders.push(input);
          return {
            orderId: "offline-order",
            totalCents: 2468,
            pixCopyPaste: "OFFLINE",
            status: "pending",
          };
        },
      },
      new ConversationInputService(),
      { findCurrentOffer: never },
      config(),
    );
    const accepted = await engine.ensureSelectedOptionPrice(selected);
    assert.equal(accepted.pricePf, 12.34);
    conversation.selectedPresentation = accepted;
    conversation.pendingAction = State.WAITING_QUANTITY;
    await engine.resolveReply(conversation, "2");
    assert.equal(conversation.cart[0].unitPrice, 12.34);
    assert.equal(conversation.cart[0].pricePolicy, backupPricePolicy(source));
    conversation.pendingAction = State.WAITING_CONFIRMATION;
    conversation.pendingAddress = {
      cep: "88301080",
      logradouro: "Rua Teste",
      bairro: "Centro",
      localidade: "Itajai",
      uf: "SC",
      number: "1",
    };
    await engine.resolveReply(conversation, "1");
    assert.equal(orders.length, 1);
    assert.equal(orders[0].cart[0].total, 24.68);
  });

test("old or changed backup policies are not automatically treated as current sale prices", () => {
  assert.equal(hasBackupPrice({ source: "pharmadb", pricePf: 12 }), false);
  assert.equal(
    hasBackupPrice(
      {
        source: "pharmadb",
        pricePf: 12,
        pricePolicy: "pharmadb_pf_or_pmc_v1:0.5",
      },
      config({ PHARMADB_PMC_PRICE_MULTIPLIER: 0.6 }),
    ),
    false,
  );
  assert.equal(
    hasBackupPrice({
      source: "bulapi",
      pricePf: 0,
      pricePolicy: "bulapi_max_pf_v1",
    }),
    false,
  );
});
