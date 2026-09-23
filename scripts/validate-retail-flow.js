const assert = require("node:assert/strict");
const {
  ManualRetailProductService,
} = require("../dist/integrations/manual-retail-product.service");
const {
  ProductSearchOrchestratorService,
} = require("../dist/integrations/product-search-orchestrator.service");
const {
  formatProductDisplayName,
  WhatsappCopy,
} = require("../dist/whatsapp/whatsapp-copy");

global.fetch = async () => assert.fail("Unexpected network call");

async function run() {
  const manual = new ManualRetailProductService();

  assert.equal(manual.findGenericCategory("shampoo"), "shampoo");
  assert.equal(manual.findGenericCategory("sabonete"), "sabonete");
  assert.equal(manual.isRetailProductQuery("tem dipirona?"), false);
  assert.equal(manual.resolveBrandSelection("shampoo", "1"), "Seda");
  assert.equal(manual.resolveBrandSelection("shampoo", "6"), "qualquer marca");
  assert.equal(
    formatProductDisplayName("SHAMPOO SEDA KERAFORCE"),
    "Seda Keraforce Shampoo",
  );
  assert.equal(
    formatProductDisplayName(
      "KÉRASTASE RESISTANCE CIMENT ANTI-USURE CONDICIONADOR 200ML",
    ),
    "Kérastase Resistance Ciment Anti-Usure Condicionador 200ml",
  );
  assert.equal(
    formatProductDisplayName("Cimegripe Capsula UNKNOWN - caixa com 10 cápsulas"),
    "Cimegripe Cápsulas - caixa com 10 cápsulas",
  );
  assert.doesNotMatch(
    formatProductDisplayName("Dorflex Comprimido UNKNOWN"),
    /UNKNOWN|undefined|null|NaN|\[object Object\]/i,
  );
  assert.equal(formatProductDisplayName(null), "");
  assert.match(
    WhatsappCopy.askRetailBrand("shampoo", manual.getPopularBrands("shampoo")),
    /Você tem alguma marca de preferência/,
  );

  manual.search = async () => assert.fail("Manual catalog prices are retired");
  manual.createManualProduct = () => assert.fail("Do not fabricate offers");
  const offers = [
    { source: "preco_popular", sourceId: "1", productName: "Shampoo Pantene 400ml", displayName: "Shampoo Pantene 400ml", brand: "Pantene", salePrice: 32.59 },
    { source: "preco_popular", sourceId: "2", productName: "Kit Shampoo Pantene + Condicionador", displayName: "Kit Shampoo Pantene + Condicionador", brand: "Pantene", salePrice: 49.9 },
    { source: "preco_popular", sourceId: "3", productName: "Shampoo Seda 325ml", displayName: "Shampoo Seda 325ml", brand: "Seda", salePrice: 18.75 },
  ];
  let calls = 0;
  const catalog = { isEnabled: () => true, searchRetail: async () => { calls++; return offers; } };
  const orchestrator = new ProductSearchOrchestratorService(manual, catalog);
  const summary = await orchestrator.searchProducts("shampoo pantene");
  assert.equal(summary.options.length, 1);
  assert.equal(summary.options[0].pricePf, 32.59);
  assert.equal(summary.options[0].source, "preco_popular");
  assert.equal(summary.manualFallback, false);
  const anyBrand = await orchestrator.searchProducts(orchestrator.buildQueryFromBrandSelection("shampoo", "qualquer marca"));
  assert.equal(anyBrand.options.length, 2);
  assert.ok(anyBrand.options.every((item) => item.pricePf > 0));
  assert.equal(calls, 2);
  const empty = new ProductSearchOrchestratorService(manual, {
    isEnabled: () => true, searchRetail: async () => [],
  });
  assert.deepEqual((await empty.searchProducts("sabonete dove")).options, []);
  const failed = new ProductSearchOrchestratorService(manual, {
    isEnabled: () => true, searchRetail: async () => { throw new Error("offline"); },
  });
  assert.deepEqual((await failed.searchProducts("fralda pampers")).options, []);
  const noPrice = new ProductSearchOrchestratorService(manual, {
    isEnabled: () => true, searchRetail: async () => offers.map((item) => ({ ...item, salePrice: undefined })),
  });
  assert.deepEqual((await noPrice.searchProducts("shampoo")).options, []);
  console.log("Retail routing, copy, actual prices and sole-catalog validations passed.");
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
