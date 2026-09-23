// Opt-in live, read-only catalog check. No .env, database, backups, WhatsApp or Pix.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Logger } = require("@nestjs/common");
const { PrecoPopularService } = require("../dist/integrations/preco-popular.service");
const { CommercialMedicineSelector } = require("../dist/integrations/commercial-medicine-selector");
const { MedicineSearchOrchestratorService } = require("../dist/integrations/medicine-search-orchestrator.service");

async function run() {
  if (!process.argv.includes("--live")) {
    console.log("Explicit live opt-in required: node scripts/diagnose-medicine-names.js --live");
    return;
  }
  Logger.overrideLogger(false);
  const report = { startedAt: new Date().toISOString(), context: "local production classes, no production logs or database", requests: [], queries: [] };
  const originalFetch = global.fetch;
  let failed = false;
  global.fetch = async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://www.precopopular.com.br");
    assert.equal(url.pathname, "/api/catalog_system/pub/products/search");
    if (failed || report.requests.length >= 10) throw new Error("Diagnostic request limit reached");
    const request = { query: url.searchParams.get("ft"), endpoint: url.toString(), status: null };
    report.requests.push(request);
    const start = Date.now();
    try {
      const response = await originalFetch(input, init);
      request.status = response.status;
      request.durationMs = Date.now() - start;
      failed ||= !response.ok;
      return response;
    } catch (error) {
      failed = true;
      request.error = error.message;
      throw error;
    }
  };
  try {
    const selector = new CommercialMedicineSelector();
    const provider = new PrecoPopularService({ get: () => undefined }, selector);
    const search = new MedicineSearchOrchestratorService(selector, {}, { getRulesForPrinciple: async () => [] }, provider);
    for (const query of ["Elexir paregórico", "Elixir paregórico", "Tem elexir paregórico?", "Paregórico", "dipirona", "novalgina"]) {
      const before = report.requests.length;
      const result = await search.searchMedicine(query);
      const row = { query, parsedName: selector.parseMedicineQuery(query).medicineName,
        status: result.searchStatus, failureReason: result.failureReason, calls: report.requests.length - before,
        selected: result.options.map((o) => ({ name: o.label, price: o.pricePf, ean: o.ean, dosage: o.strength, source: o.source })) };
      report.queries.push(row);
      console.log(JSON.stringify(row));
      if (failed) break;
    }
    assert.equal(failed, false, "A live request failed; inspect the diagnostic report");
    assert.ok(report.queries.every((q) => q.selected.length), "A query returned no selected product");
    assert.ok(report.queries.slice(0, 4).every((q) => q.selected.some((o) => o.ean === "7896023701436")), "Screenshot product did not match");
  } finally {
    global.fetch = originalFetch;
    report.finishedAt = new Date().toISOString();
    const dir = path.join(__dirname, "..", "diagnostics");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `medicine-names-${report.startedAt.replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2), { flag: "wx" });
    console.log(`Read-only diagnostic: ${file}`);
  }
}
run().catch((error) => { console.error(error.message); process.exitCode = 1; });
