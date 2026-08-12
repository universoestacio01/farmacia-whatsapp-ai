const assert = require("node:assert/strict");

const {
  CommercialMedicineSelector,
} = require("../dist/integrations/commercial-medicine-selector");
const {
  MedicineSearchOrchestratorService,
} = require("../dist/integrations/medicine-search-orchestrator.service");
const { PharmaDbService } = require("../dist/integrations/pharmadb.service");
const {
  DEFAULT_MEDICINE_PRIORITY_RULES,
} = require("../dist/config/medicine-priority-rules.config");

function option(
  productName,
  displayName,
  substance,
  dosage,
  presentation,
  source = "pharmadb",
) {
  return {
    source,
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

function createOrchestrator(pharmaSearch, manualSearch = async () => []) {
  const selector = new CommercialMedicineSelector();
  const config = { get: (name) => (name === "MEDICINE_PRIMARY_PROVIDER" ? "pharmadb" : undefined) };
  const pharmaDb = { search: pharmaSearch };
  const bulaApi = { lookupMedicine: async () => null };
  const manual = { search: manualSearch, findSymptomOptions: () => null };
  const priorityRules = {
    getRulesForPrinciple: async (principle) =>
      DEFAULT_MEDICINE_PRIORITY_RULES.filter(
        (rule) => rule.principleActive === principle,
      ),
  };

  return {
    selector,
    orchestrator: new MedicineSearchOrchestratorService(
      config,
      selector,
      pharmaDb,
      bulaApi,
      manual,
      priorityRules,
    ),
  };
}

async function testRetailCurationPreferredOverRawApi() {
  const { orchestrator } = createOrchestrator(
    async (term) => {
      if (term === "dipirona" || term === "novalgina") {
        return [
          option(
            "Lqfex - Dipirona",
            "Lqfex - Dipirona Comprimido 500mg",
            "dipirona",
            "500mg",
            "500 MG COM CT BL X 20",
          ),
          option(
            "Dipirona Sodica",
            "Dipirona Sodica Sol Inj",
            "dipirona",
            "500mg/ml",
            "500 MG/ML SOL INJ CX 100 AMP VD AMB X 2 ML",
          ),
          option(
            "Novalgina",
            "Novalgina Comprimido 1g",
            "dipirona",
            "1g",
            "1 G COM CT BL X 10",
          ),
        ];
      }

      return [];
    },
    async (query) => {
      const canonical = new CommercialMedicineSelector().getCanonicalMedicineName(query);

      if (canonical !== "dipirona") {
        return [];
      }

      return [
        option(
          "Novalgina",
          "Novalgina Comprimido 500mg",
          "dipirona",
          "500mg",
          "500 MG COM CT BL X 10",
          "popular_manual",
        ),
        option(
          "Dipirona",
          "Dipirona genérica Comprimido 500mg",
          "dipirona",
          "500mg",
          "500 MG COM CT BL X 10",
          "popular_manual",
        ),
        option(
          "Novalgina",
          "Novalgina Gotas / solução oral",
          "dipirona",
          "500mg/ml",
          "500 MG/ML SOL OR CT FR GOT X 20 ML",
          "popular_manual",
        ),
      ];
    },
  );

  const summary = await orchestrator.searchMedicine("Preciso de dipirona");
  const labels = summary.options.map((item) => item.label).join(" | ");

  assert.match(labels, /Novalgina Comprimido 500mg/i);
  assert.match(labels, /Novalgina Comprimido 1g/i);
  assert.match(labels, /Gotas|solução oral/i);
  assert.doesNotMatch(labels, /Lqfex|Sol Inj|Amp/i);
}

async function testDorflexRetailLabels() {
  const { orchestrator } = createOrchestrator(
    async (term) => {
      if (term === "dorflex") {
        return [
          option(
            "Dorflex",
            "Dorflex",
            "dorflex",
            "35mg",
            "(35 + 300 + 50) MG COM CT BL X 8",
          ),
        ];
      }

      return [];
    },
    async () => [
      option(
        "Dorflex",
        "Dorflex Comprimido",
        "dorflex",
        undefined,
        "(35 + 300 + 50) MG COM CT BL X 8",
        "popular_manual",
      ),
      option(
        "Dorflex",
        "Dorflex Comprimido",
        "dorflex",
        undefined,
        "(35 + 300 + 50) MG COM CT BL X 16",
        "popular_manual",
      ),
      option(
        "Dorflex Uno",
        "Dorflex Uno 1g",
        "dorflex",
        "1g",
        "1 G COM CT BL X 10",
        "popular_manual",
      ),
    ],
  );

  const summary = await orchestrator.searchMedicine("Tem dorflex?");
  const labels = summary.options.map((item) => item.label).join(" | ");

  assert.match(labels, /Dorflex Comprimido/i);
  assert.match(labels, /Dorflex Uno 1g/i);
  assert.doesNotMatch(labels, /35mg/i);
}

async function testParser() {
  const selector = new CommercialMedicineSelector();
  const cases = [
    ["10 tadala de 20 pro meu amigo Diego", "tadala", "tadalafila", 20, 10],
    ["Quero comprar 10 tadalafila de 20 mg", "tadalafila", "tadalafila", 20, undefined],
    ["Cloridrato de ciprofloxacina", "ciprofloxacina", "ciprofloxacino", undefined, undefined],
    ["Cloridrato de fexofenadina", "fexofenadina", "fexofenadina", undefined, undefined],
    ["Allegra", "allegra", "fexofenadina", undefined, undefined],
    ["Plenance de 10 mg", "plenance", "tadalafila", 10, undefined],
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

async function testConfigurableCommercialRanking() {
  const selector = new CommercialMedicineSelector();
  const rules = [
    {
      principleActive: "dipirona",
      brand: "Novalgina",
      dosageMg: 500,
      quantity: 10,
      formGroup: "comprimido",
      priority: 1000,
    },
    {
      principleActive: "dipirona",
      brand: "Novalgina",
      dosageMg: 1000,
      quantity: 10,
      formGroup: "comprimido",
      priority: 100,
    },
  ];
  const options = [
    {
      productName: "Dipirona Sodica",
      medicineName: "dipirona",
      label: "Dipirona Sodica Comprimido 500mg - caixa com 30 unidades",
      formGroup: "comprimido",
      strength: "500mg",
      presentationId: 1,
      packageInfo: selector.extractPackageInfo("comprimido 500mg caixa com 30 comprimidos"),
      pricePf: 9.9,
    },
    {
      productName: "Novalgina",
      medicineName: "dipirona",
      label: "Novalgina Comprimido 500mg - caixa com 10 unidades",
      formGroup: "comprimido",
      strength: "500mg",
      presentationId: 2,
      packageInfo: selector.extractPackageInfo("comprimido 500mg caixa com 10 comprimidos"),
      pricePf: 14.9,
    },
    {
      productName: "Dipirona Sodica",
      medicineName: "dipirona",
      label: "Dipirona Sodica Gotas 500mg/ml - frasco com 20ml",
      formGroup: "gotas",
      strength: "500mg/ml",
      presentationId: 3,
      packageInfo: selector.extractPackageInfo("gotas 500mg/ml frasco com 20ml"),
      pricePf: 7.9,
    },
    {
      productName: "Dipirona Sodica",
      medicineName: "dipirona",
      label: "Dipirona Sodica Comprimido 500mg - caixa com 10 unidades",
      formGroup: "comprimido",
      strength: "500mg",
      presentationId: 4,
      packageInfo: selector.extractPackageInfo("comprimido 500mg caixa com 10 comprimidos"),
      pricePf: 6.9,
    },
    {
      productName: "Novalgina",
      medicineName: "dipirona",
      label: "Novalgina Comprimido 1g - caixa com 10 unidades",
      formGroup: "comprimido",
      strength: "1g",
      presentationId: 5,
      packageInfo: selector.extractPackageInfo("comprimido 1g caixa com 10 comprimidos"),
      pricePf: 18.9,
    },
  ];

  const ranked = selector.rankCommercialOptions("dipirona", options, rules);
  assert.equal(ranked.selected.length, 3);
  assert.match(ranked.selected[0].label, /Novalgina/i);
  assert.match(ranked.selected.map((item) => item.label).join(" | "), /1g/i);
  assert.ok(ranked.scored.some((item) => item.quantity === 30));
  assert.ok(
    new Set(
      ranked.selected.map((item) =>
        [item.formGroup, item.strength, item.packageInfo?.unitCount, item.packageInfo?.volumeMl].join("|"),
      ),
    ).size >= 2,
  );
}

async function testVenvanseDosageDiversity() {
  const { orchestrator } = createOrchestrator(async (term) => {
    if (term === "venvanse" || term === "venvanse 30mg") {
      return [
        option("Venvanse", "Venvanse Cápsula 30mg", "venvanse", "30mg", "30 MG CAP CT FR X 28"),
        option("Venvanse", "Venvanse Cápsula 30mg", "venvanse", "30mg", "30 MG CAP CT FR PLAS X 28"),
      ];
    }

    if (term === "venvanse 50mg") {
      return [
        option("Venvanse", "Venvanse Cápsula 50mg", "venvanse", "50mg", "50 MG CAP CT FR X 28"),
      ];
    }

    return [];
  });

  orchestrator.popularManualService = {
    search: async () => [
      option("Venvanse", "Venvanse Cápsula 30mg", "venvanse", "30mg", "30 MG CAP CT FR X 28"),
      option("Venvanse", "Venvanse Cápsula 50mg", "venvanse", "50mg", "50 MG CAP CT FR X 28"),
      option("Venvanse", "Venvanse Cápsula 70mg", "venvanse", "70mg", "70 MG CAP CT FR X 28"),
    ],
  };

  const summary = await orchestrator.searchMedicine("Tem venvanse?");
  const labels = summary.options.map((item) => item.label).join(" | ");

  assert.match(labels, /30mg/i);
  assert.match(labels, /50mg/i);
  assert.match(labels, /70mg/i);
  assert.equal(
    new Set(summary.options.map((item) => item.strength?.toLowerCase())).size,
    3,
  );

  const exactSummary = await orchestrator.searchMedicine("Tem venvanse de 70mg?");
  assert.equal(exactSummary.options.length, 1);
  assert.match(exactSummary.options[0].label, /70mg/i);
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
  await testRetailCurationPreferredOverRawApi();
  await testDorflexRetailLabels();
  await testSearchFallbacksAndRanking();
  await testPharmaDbPagination();
  await testConfigurableCommercialRanking();
  await testVenvanseDosageDiversity();
  console.log("Medicine search regression tests passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
