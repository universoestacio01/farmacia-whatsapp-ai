// Offline only: replay captured live catalog responses through the conversation engine.
const fs = require("node:fs");
const path = require("node:path");
const { Logger } = require("@nestjs/common");
const { Prisma, ConversationState } = require("@prisma/client");
const { PrecoPopularService } = require("../dist/integrations/preco-popular.service");
const { CommercialMedicineSelector } = require("../dist/integrations/commercial-medicine-selector");
const { MedicinePriorityRulesService } = require("../dist/integrations/medicine-priority-rules.service");
const { MedicineSearchOrchestratorService } = require("../dist/integrations/medicine-search-orchestrator.service");
const { ProductSearchOrchestratorService } = require("../dist/integrations/product-search-orchestrator.service");
const { ManualRetailProductService } = require("../dist/integrations/manual-retail-product.service");
const { PopularManualMedicineService } = require("../dist/integrations/popular-manual-medicine.service");
const { BulaApiService } = require("../dist/integrations/bula-api.service");
const { ConversationEngineService } = require("../dist/whatsapp/conversation-engine.service");
const { medicines, variations } = require("./catalog-diagnostic-cases");

const files = process.argv.slice(2);
if (!files.length) throw new Error("Supply captured catalog report JSON paths");
const reports = files.map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
const captures = new Map(reports.flatMap((report) => report.requests).map((request) => [request.endpoint, request]));
const results = [];
const missingCaptures = [];
Logger.overrideLogger(false);
global.fetch = async (input) => {
  const capture = captures.get(String(input));
  if (!capture) {
    missingCaptures.push(String(input));
    throw new Error("No captured response for URL; network is forbidden");
  }
  return new Response(JSON.stringify(capture.body), {
    status: capture.status, headers: { resources: capture.resources || "" },
  });
};
const never = async () => { throw new Error("Unexpected external dependency"); };

async function run() {
  for (const query of [...medicines, ...variations]) {
    const selector = new CommercialMedicineSelector();
    const config = { get: () => undefined };
    const provider = new PrecoPopularService(config, selector);
    const priorities = new MedicinePriorityRulesService({ safePrismaCall: async () => [] }, selector);
    const search = new MedicineSearchOrchestratorService(selector, new PopularManualMedicineService(selector), priorities, provider);
    const retail = new ProductSearchOrchestratorService(new ManualRetailProductService(), provider);
    const conversation = {
      id: "offline-audit", customerId: "offline-audit", pendingAction: ConversationState.IDLE,
      lastIntent: null, lastMedicine: null, currentMedicineQuery: null, currentRetailCategory: null,
      selectedPresentation: null, candidateOptions: [], cart: [], pendingAddress: null,
    };
    const prisma = { conversation: { update: async ({ data }) => {
      for (const [key, value] of Object.entries(data)) conversation[key] = value === Prisma.JsonNull ? null : value;
      return conversation;
    } } };
    const engine = new ConversationEngineService(prisma,
      { canReadPackageImages: () => false, generatePharmacyReply: never },
      new BulaApiService(config, selector, {}), search, retail,
      { findAddressByCep: never }, { confirmCheckout: never });
    try {
      const reply = await engine.resolveReply(conversation, `Tem ${query}?`);
      const result = { query, retail: retail.isRetailProductQuery(query), reply,
        state: conversation.pendingAction, options: conversation.candidateOptions,
        selected: conversation.selectedPresentation };
      results.push(result);
      console.log(JSON.stringify({query,retail:result.retail,state:result.state,options:Array.isArray(result.options)?result.options.length:0,
        reply: ['coristina d','resfenol','minancora','plenance','puran t4 25mcg','euthyrox 50mcg','amoxicilina 250mg/5ml'].includes(query) ? reply : undefined}));
    } catch (error) {
      results.push({ query, error: error.message });
      console.log(JSON.stringify({query,error:error.message}));
    }
  }
  const output = path.resolve("diagnostics", `conversation-replay-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(output, JSON.stringify({ sources:files, networkCalls:0, scope:"Offline conversation engine with actual captured HTTP bodies; no WhatsApp, AI or database", missingCaptures, results }, null, 2), {flag:"wx"});
  console.log(JSON.stringify({output,scenarios:results.length,missingCaptures,errors:results.filter(r=>r.error).length}));
}
run().catch((error) => { console.error(error.message); process.exitCode = 1; });
