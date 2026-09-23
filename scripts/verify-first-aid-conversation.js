// Two public catalog requests at most; conversation persistence is in memory.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { Logger } = require("@nestjs/common");
const { Prisma, ConversationState } = require("@prisma/client");
const { CommercialMedicineSelector } = require("../dist/integrations/commercial-medicine-selector");
const { PrecoPopularService } = require("../dist/integrations/preco-popular.service");
const { MedicineSearchOrchestratorService } = require("../dist/integrations/medicine-search-orchestrator.service");
const { ProductSearchOrchestratorService } = require("../dist/integrations/product-search-orchestrator.service");
const { ManualRetailProductService } = require("../dist/integrations/manual-retail-product.service");
const { BulaApiService } = require("../dist/integrations/bula-api.service");
const { ConversationEngineService } = require("../dist/whatsapp/conversation-engine.service");
const { PRECO_POPULAR_BASE_URL } = require("../dist/config/preco-popular.config");
Logger.overrideLogger(false);
const report = { startedAt: new Date().toISOString(), requests: [], conversations: [] };
const originalFetch = global.fetch;
global.fetch = async (input, init) => {
  const url = new URL(input);
  assert.equal(url.origin, PRECO_POPULAR_BASE_URL);
  assert.equal(url.pathname, "/api/catalog_system/pub/products/search");
  assert.ok(report.requests.length < 2, "Maximum two HTTP requests");
  const trace = { endpoint: String(input) };
  report.requests.push(trace);
  const response = await originalFetch(input, init);
  trace.status = response.status;
  trace.resources = response.headers.get("resources");
  return response;
};
const never = async () => { throw new Error("DB, WhatsApp, payments and AI are forbidden in this diagnostic"); };
const selector = new CommercialMedicineSelector();
const config = { get: () => undefined };
const provider = new PrecoPopularService(config, selector);
const retail = new ProductSearchOrchestratorService(new ManualRetailProductService(), provider);
const medicines = new MedicineSearchOrchestratorService(selector, { findSymptomSuggestion: () => null }, { getRulesForPrinciple: async () => [] }, provider);
const conversation = { id: "local-diagnostic", customerId: "local-diagnostic", pendingAction: ConversationState.IDLE, cart: [], selectedPresentation: null, candidateOptions: null };
const prisma = { conversation: { update: async ({data}) => {
  for (const [key, value] of Object.entries(data)) conversation[key] = value === Prisma.JsonNull ? null : value;
  return conversation;
} } };
const engine = new ConversationEngineService(prisma, {generatePharmacyReply: never}, new BulaApiService(config, selector, {}), medicines,
  retail, { findAddressByCep: never }, { confirmCheckout: never });
async function run() {
  for (const message of ["Tem soro fisiológico ?", "Tem soro fisiologico 500ml?"]) {
    const reply = await engine.resolveReply(conversation, message);
    const result = { message, reply, options: (conversation.candidateOptions || []).map((option) => ({
      name: option.label, price: option.pricePf, sourceId: option.sourceId, type: option.type,
    })) };
    report.conversations.push(result);
    console.log(JSON.stringify(result));
    assert.ok(result.options.length, "No options returned");
    assert.ok(result.options.every((option) => option.type === "retail_product" && option.price > 0));
    if (message.includes("500ml")) assert.ok(result.options.every((option) => /500ml/i.test(option.name)));
  }
}
run().catch((error) => { report.error = error.message; process.exitCode = 1; }).finally(() => {
  global.fetch = originalFetch;
  const output = path.join(__dirname, "..", "diagnostics", `first-aid-conversation-${report.startedAt.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(output, JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ output, requests: report.requests, error: report.error }));
});
