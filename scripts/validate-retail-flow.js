const assert = require("node:assert/strict");
const { CosmosService } = require("../dist/integrations/cosmos.service");
const {
  CosmosTokenPoolService,
} = require("../dist/integrations/cosmos-token-pool.service");
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

function config(values) {
  return {
    get(key) {
      return values[key];
    },
  };
}

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
  assert.match(
    WhatsappCopy.askRetailBrand("shampoo", manual.getPopularBrands("shampoo")),
    /Você tem alguma marca de preferência/,
  );

  let cosmosCalls = 0;
  const fakeCosmos = {
    async search(query) {
      cosmosCalls += 1;
      assert.equal(query, "shampoo pantene");
      return [
        {
          source: "cosmos",
          productName: "Kit Shampoo Pantene + Condicionador",
          displayName: "Kit Shampoo Pantene + Condicionador",
          description: "Kit Shampoo Pantene + Condicionador",
          brand: "Pantene",
          salePrice: 39.9,
        },
        {
          source: "cosmos",
          productName: "Shampoo Pantene 400ml",
          displayName: "Shampoo Pantene 400ml",
          description: "Shampoo Pantene 400ml",
          brand: "Pantene",
          salePrice: 18.5,
          imageUrl: "https://example.com/pantene.png",
        },
        {
          source: "cosmos",
          productName: "Shampoo Pantene sem preco",
          displayName: "Shampoo Pantene sem preco",
          description: "Shampoo Pantene sem preco",
          brand: "Pantene",
        },
      ];
    },
    async findByGtin() {
      return null;
    },
  };
  const orchestrator = new ProductSearchOrchestratorService(fakeCosmos, manual);
  const summary = await orchestrator.searchProducts("shampoo pantene");

  assert.equal(cosmosCalls, 1);
  assert.equal(summary.options.length, 2);
  assert.equal(summary.options[0].label, "Shampoo Pantene 400ml");
  assert.equal(summary.options[0].pricePf, 18.5);

  const noPriceOrchestrator = new ProductSearchOrchestratorService(
    {
      async search() {
        return [
          {
            source: "cosmos",
            productName: "Sabonete Dove",
            displayName: "Sabonete Dove",
            description: "Sabonete Dove",
            brand: "Dove",
          },
        ];
      },
      async findByGtin() {
        return null;
      },
    },
    manual,
  );
  const noPriceSummary = await noPriceOrchestrator.searchProducts("sabonete dove");
  assert.equal(noPriceSummary.options.length, 1);
  assert.equal(noPriceSummary.options[0].pricePf, 4.99);
  assert.doesNotMatch(
    WhatsappCopy.showRetailOptions(
      noPriceSummary.category,
      noPriceSummary.requestedBrand,
      noPriceSummary.options,
      (value) => `R$ ${Number(value).toFixed(2)}`,
    ),
    /orcamento|orçamento|sem preco|sem preço/i,
  );

  const premiumFallbackSummary = await new ProductSearchOrchestratorService(
    {
      async search() {
        return [];
      },
      async findByGtin() {
        return null;
      },
    },
    manual,
  ).searchProducts("shampoo kerastase");
  assert.equal(premiumFallbackSummary.options.length, 1);
  assert.equal(premiumFallbackSummary.options[0].pricePf, 119.9);

  let genericCategoryCosmosCalls = 0;
  const genericCategorySummary = await new ProductSearchOrchestratorService(
    {
      async search() {
        genericCategoryCosmosCalls += 1;
        return [];
      },
      async findByGtin() {
        return null;
      },
    },
    manual,
  ).searchProducts("shampoo");
  assert.equal(genericCategoryCosmosCalls, 0);
  assert.equal(genericCategorySummary.options.length, 3);
  assert.match(genericCategorySummary.options[0].label, /Shampoo/);

  const deodorantFallbackSummary = await new ProductSearchOrchestratorService(
    {
      async search() {
        return [];
      },
      async findByGtin() {
        return null;
      },
    },
    manual,
  ).searchProducts("desodorante rexona");
  assert.equal(deodorantFallbackSummary.options[0].pricePf, 13.9);

  const diaperFallbackSummary = await new ProductSearchOrchestratorService(
    {
      async search() {
        return [];
      },
      async findByGtin() {
        return null;
      },
    },
    manual,
  ).searchProducts("fralda pampers");
  assert.equal(diaperFallbackSummary.options[0].pricePf, 39.9);

  let fetchCalls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    fetchCalls += 1;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          products: [
            {
              description: "SABONETE DOVE 90G",
              gtin: "7890000000000",
              avg_price: 4.75,
            },
          ],
        };
      },
    };
  };

  const cosmosConfig = config({
    COSMOS_API_TOKEN: "token-a",
    COSMOS_API_BASE_URL: "https://api.cosmos.bluesoft.com.br",
    COSMOS_USER_AGENT: "farmacia-whatsapp-ai",
    COSMOS_CACHE_TTL_HOURS: 24,
  });
  const tokenPool = new CosmosTokenPoolService(cosmosConfig);
  const cosmos = new CosmosService(cosmosConfig, tokenPool);
  await cosmos.search("sabonete dove");
  await cosmos.search("sabonete dove");
  assert.equal(fetchCalls, 1);
  global.fetch = originalFetch;

  const pool = new CosmosTokenPoolService(
    config({
      COSMOS_API_TOKENS: "token-a,token-b",
      COSMOS_TOKEN_429_COOLDOWN_MINUTES: 30,
    }),
  );
  const first = pool.selectToken();
  assert.equal(first.index, 0);
  pool.markRateLimited(0);
  const second = pool.selectToken();
  assert.equal(second.index, 1);
  pool.markInvalid(1);
  assert.equal(pool.selectToken(), null);

  console.log("Retail flow manual tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
