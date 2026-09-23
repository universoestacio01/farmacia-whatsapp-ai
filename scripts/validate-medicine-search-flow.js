const assert = require("node:assert/strict");
const { Logger } = require("@nestjs/common");
const { CommercialMedicineSelector } = require("../dist/integrations/commercial-medicine-selector");
const { MedicineSearchOrchestratorService } = require("../dist/integrations/medicine-search-orchestrator.service");
const { DEFAULT_MEDICINE_PRIORITY_RULES } = require("../dist/config/medicine-priority-rules.config");
Logger.overrideLogger(false);
global.fetch = async () => assert.fail("Unexpected network call");

async function testParser() {
  const selector = new CommercialMedicineSelector();
  const cases = [
    ["10 tadala de 20 pro meu amigo Diego", "tadala", "tadalafila", 20, 10],
    ["Quero comprar 10 tadalafila de 20 mg", "tadalafila", "tadalafila", 20, undefined],
    ["Cloridrato de ciprofloxacina", "ciprofloxacina", "ciprofloxacino", undefined, undefined],
    ["Cloridrato de fexofenadina", "fexofenadina", "fexofenadina", undefined, undefined],
    ["Allegra", "allegra", "fexofenadina", undefined, undefined],
    ["Plenance de 10 mg", "plenance", "rosuvastatina", 10, undefined],
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


async function testSoleCatalogRanking() {
  const selector = new CommercialMedicineSelector();
  const raw = [30, 30, 50, 70].map((dose, index) => ({
    source: "preco_popular", sourceId: String(index + 1),
    productName: `Venvanse ${dose}mg com 28 capsulas`,
    displayName: `Venvanse ${dose}mg com 28 capsulas`,
    brand: "Venvanse", activeIngredient: "lisdexanfetamina",
    dosage: `${dose}mg`, form: "capsula", presentation: `capsula ${dose}mg com 28 unidades`,
    packageInfo: { raw: "capsula 28 unidades", unitCount: 28 }, salePrice: 429.9,
  }));
  let calls = 0;
  const orchestrator = new MedicineSearchOrchestratorService(
    selector,
    { search: async () => assert.fail("Manual catalog must not replace actual offers") },
    { getRulesForPrinciple: async (name) => DEFAULT_MEDICINE_PRIORITY_RULES.filter((rule) => rule.principleActive === name) },
    { isEnabled: () => true, searchMedicines: async () => { calls++; return raw; } },
  );
  const broad = await orchestrator.searchMedicine("Tem venvanse?");
  assert.deepEqual(broad.options.map((item) => item.strength).sort(), ["30mg", "50mg", "70mg"]);
  const exact = await orchestrator.searchMedicine("Tem venvanse de 70mg?");
  assert.equal(exact.options.length, 1);
  assert.equal(exact.options[0].strength, "70mg");
  assert.equal(exact.options[0].pricePf, 429.9);
  const unavailable = await orchestrator.searchMedicine("venvanse 80mg");
  assert.equal(unavailable.options.length, 0);
  assert.equal(calls, 3);
}

async function run() {
  await testParser();
  await testConfigurableCommercialRanking();
  await testSoleCatalogRanking();
  console.log("Medicine parsing, ranking and sole-catalog regression tests passed.");
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
