const assert = require("node:assert/strict");

const {
  CommercialMedicineSelector,
} = require("../dist/integrations/commercial-medicine-selector");
const {
  MedicineSearchOrchestratorService,
} = require("../dist/integrations/medicine-search-orchestrator.service");
const { PharmaDbService } = require("../dist/integrations/pharmadb.service");

function option(productName, displayName, substance, dosage, presentation) {
  return {
    source: "pharmadb",
    sourceId: `${productName}-${dosage}-${presentation}`,
    productName,
    displayName,
    substance,
    activeIngredient: substance,
    dosage,
    presentation,
    form: presentation,
    priceConsumer: 20,
  };
}

function createOrchestrator(pharmaSearch) {
  const selector = new CommercialMedicineSelector();
  const config = { get: (name) => (name === "MEDICINE_PRIMARY_PROVIDER" ? "pharmadb" : undefined) };
  const pharmaDb = { search: pharmaSearch };
  const bulaApi = { lookupMedicine: async () => null };
  const manual = { search: async () => [], findSymptomOptions: () => null };

  return {
    selector,
    orchestrator: new MedicineSearchOrchestratorService(
      config,
      selector,
      pharmaDb,
      bulaApi,
      manual,
    ),
  };
}

async function testParser() {
  const selector = new CommercialMedicineSelector();
  const cases = [
    ["10 tadala de 20 pro meu amigo Diego", "tadala", "tadalafila", 20, 10],
    ["Quero comprar 10 tadalafila de 20 mg", "tadalafila", "tadalafila", 20, undefined],
    ["Cloridrato de ciprofloxacina", "ciprofloxacina", "ciprofloxacino", undefined, undefined],
    ["Cloridrato de fexofenadina", "fexofenadina", "fexofenadina", undefined, undefined],
    ["Allegra", "allegra", "fexofenadina", undefined, undefined],
    ["Plenance de 10 mg", "plenance", "plenance", 10, undefined],
    ["Viagra", "viagra", "sildenafila", undefined, undefined],
    ["Dipirona 1g", "dipirona", "dipirona", 1000, undefined],
    ["Dipirona 0,5g", "dipirona", "dipirona", 500, undefined],
  ];

  for (const [input, name, canonical, dose, quantity] of cases) {
    const parsed = selector.parseMedicineQuery(input);
    assert.equal(parsed.medicineName, name, input);
    assert.equal(parsed.canonicalName, canonical, input);
    assert.equal(parsed.dosageMg, dose, input);
    assert.equal(parsed.quantity, quantity, input);
  }
}

async function testSearchFallbacksAndRanking() {
  const calls = [];
  const { orchestrator } = createOrchestrator(async (term) => {
    calls.push(term);

    if (["tadala", "tadalafila", "cialis"].includes(term)) {
      return [
        option("Tadalafila", "Tadalafila 5mg", "tadalafila", "5mg", "comprimido"),
        option("Tadalafila", "Tadalafila 20mg", "tadalafila", "20mg", "comprimido"),
      ];
    }

    if (["allegra", "fexofenadina", "cloridrato de fexofenadina"].includes(term)) {
      return [option("Allegra", "Allegra 120mg", "fexofenadina", "120mg", "comprimido")];
    }

    if (["ciprofloxacina", "ciprofloxacino", "cloridrato de ciprofloxacina"].includes(term)) {
      return [
        option(
          "Cloridrato de Ciprofloxacino",
          "Cloridrato de Ciprofloxacino 500mg",
          "ciprofloxacino",
          "500mg",
          "comprimido",
        ),
      ];
    }

    if (term === "dipirona" || term === "novalgina") {
      return [
        option("Novalgina", "Novalgina 500mg", "dipirona", "500mg", "comprimido"),
        option("Novalgina", "Novalgina 1g", "dipirona", "1g", "comprimido"),
      ];
    }

    return [];
  });

  const tadalafila = await orchestrator.searchMedicine("10 tadala de 20 pro meu amigo Diego");
  assert.ok(tadalafila.options.length > 0);
  assert.match(tadalafila.options[0].label, /20mg/i);
  assert.ok(calls.includes("tadalafila"));

  const allegra = await orchestrator.searchMedicine("Cloridrato de fexofenadina");
  assert.ok(allegra.options.length > 0);
  assert.match(allegra.options[0].label, /Allegra|Fexofenadina/i);

  const cipro = await orchestrator.searchMedicine("Cloridrato de ciprofloxacina");
  assert.ok(cipro.options.length > 0);
  assert.match(cipro.options[0].label, /Ciproflox/i);

  const dipirona1g = await orchestrator.searchMedicine("Dipirona 1g");
  assert.ok(dipirona1g.options.length > 0);
  assert.match(dipirona1g.options[0].label, /1g|1000mg/i);
}

async function testPharmaDbPagination() {
  const selector = new CommercialMedicineSelector();
  const config = { get: () => "https://api.pharmadb.test/v1" };
  const auth = {
    hasApiKey: () => true,
    getAccessToken: async () => "token",
    clearToken: () => undefined,
  };
  const service = new PharmaDbService(config, auth, selector);
  const endpoints = [];
  const originalFetch = global.fetch;

  global.fetch = async (url) => {
    const endpoint = String(url).replace("https://api.pharmadb.test/v1", "");
    endpoints.push(endpoint);

    if (endpoint.includes("/produtos/busca") && endpoint.includes("page=1")) {
      return response({
        data: [{ id: "p1", nome: "Produto fora da dose" }],
        meta: { current_page: 1, last_page: 2, per_page: 20, total: 2 },
      });
    }

    if (endpoint.includes("/produtos/busca") && endpoint.includes("page=2")) {
      return response({
        data: [{ id: "p2", nome: "Tadalafila" }],
        meta: { current_page: 2, last_page: 2, per_page: 20, total: 2 },
      });
    }

    if (endpoint === "/produtos/p1") {
      return response({ id: "p1", nome: "Produto fora da dose", substancia: "outra" });
    }

    if (endpoint === "/produtos/p2") {
      return response({
        id: "p2",
        nome: "Tadalafila",
        substancia: "tadalafila",
        apresentacao: "20 MG COM CT BL X 4",
        pmc: 30,
      });
    }

    return response({}, 404);
  };

  try {
    const results = await service.search("tadalafila");
    assert.ok(endpoints.some((endpoint) => endpoint.includes("page=2")));
    assert.ok(results.some((item) => item.productName === "Tadalafila"));
  } finally {
    global.fetch = originalFetch;
  }
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

async function run() {
  await testParser();
  await testSearchFallbacksAndRanking();
  await testPharmaDbPagination();
  console.log("Medicine search regression tests passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
