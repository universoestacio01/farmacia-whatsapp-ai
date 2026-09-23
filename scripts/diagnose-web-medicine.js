// Explicit opt-in, at most two real OpenAI discoveries. No DB, WhatsApp or order writes.
const fs = require("node:fs");
const path = require("node:path");
const { Logger } = require("@nestjs/common");
const { parse } = require("dotenv");
const {
  CommercialMedicineSelector,
} = require("../dist/integrations/commercial-medicine-selector");
const {
  OpenAiWebMedicineService,
} = require("../dist/integrations/openai-web-medicine.service");

async function run() {
  if (!process.argv.includes("--live"))
    throw new Error(
      "Use --live to authorize up to two real web-search requests.",
    );
  Logger.overrideLogger(false);
  const file = path.join(__dirname, "../.env");
  const env = fs.existsSync(file) ? parse(fs.readFileSync(file)) : {};
  const config = {
    get: (key) =>
      key === "OPENAI_WEB_SEARCH_DAILY_LIMIT"
        ? 2
        : key === "OPENAI_WEB_SEARCH_ENABLED"
          ? true
          : (env[key] ?? process.env[key]),
  };
  const logs = [];
  const service = new OpenAiWebMedicineService(
    config,
    new CommercialMedicineSelector(),
    { record: async (entry) => logs.push(entry) },
  );
  if (!service.isEnabled())
    throw new Error("OPENAI_API_KEY is not configured locally.");
  const requestedQueries = process.argv.slice(2).filter((arg) => arg !== "--live");
  if (requestedQueries.length > 2) throw new Error("At most two queries per run.");
  for (const query of requestedQueries.length ? requestedQueries : [
    "dipirona 1g com 10 comprimidos",
    "paracetamol 750mg com 20 comprimidos",
  ]) {
    const result = await service.searchWithStatus(query);
    console.log(
      JSON.stringify({
        query,
        status: result.status,
        reason: result.failureReason,
        options: result.options.map((option) => ({
          name: option.displayName,
          price: option.salePrice,
          source: option.webQuote?.sourceUrl,
        })),
        requests: logs
          .splice(0)
          .map((entry) => ({
            operation: entry.operation,
            http: entry.statusCode,
            endpoint: entry.endpoint,
            durationMs: entry.durationMs,
            reason: entry.failureReason,
          })),
      }),
    );
    if (result.status === "unavailable") break;
  }
}
run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
