// Read-only live catalog diagnostic. No bootstrap, database, WhatsApp or payments.
const fs = require("node:fs");
const path = require("node:path");
const { Logger } = require("@nestjs/common");
const { PrecoPopularService } = require("../dist/integrations/preco-popular.service");
const { CommercialMedicineSelector } = require("../dist/integrations/commercial-medicine-selector");
const { MedicinePriorityRulesService } = require("../dist/integrations/medicine-priority-rules.service");
const { MedicineSearchOrchestratorService } = require("../dist/integrations/medicine-search-orchestrator.service");
const { PRECO_POPULAR_BASE_URL } = require("../dist/config/preco-popular.config");
const { medicines, variations } = require("./catalog-diagnostic-cases");

Logger.overrideLogger(false);
const extended = process.argv.includes("--suite50");
const maxCalls = extended ? 104 : 16;
const startIndex = Number(process.argv.find((arg) => arg.startsWith("--start="))?.split("=")[1] || 1) - 1;
const delayMs = Number(process.argv.find((arg) => arg.startsWith("--delay-ms="))?.split("=")[1] || 400);
const waitMs = Number(process.argv.find((arg) => arg.startsWith("--wait-ms="))?.split("=")[1] || 0);
if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= 62 ||
    !Number.isFinite(delayMs) || delayMs < 0 || delayMs > 5000 ||
    !Number.isFinite(waitMs) || waitMs < 0 || waitMs > 120000) {
  throw new Error("Invalid diagnostic start/delay/wait arguments");
}
const root = path.resolve(__dirname, "..");
const envFile = path.join(root, ".env");
const local = fs.existsSync(envFile) ? require("dotenv").parse(fs.readFileSync(envFile)) : {};
const enabled = process.env.PRECO_POPULAR_ENABLED ?? local.PRECO_POPULAR_ENABLED;
const fetchOriginal = global.fetch;
const report = {
  startedAt: new Date().toISOString(), provider: "preco_popular", baseUrl: PRECO_POPULAR_BASE_URL,
  context: "Local production classes, live HTTP, default priority rules; no production database or WhatsApp.",
  suite: extended ? "50_medicines_plus_12_variations" : "8_medicines_plus_4_variations",
  startIndex: startIndex + 1, delayMs, waitMs,
  requests: [], providerEvents: [], normalizations: [], queries: [], imageChecks: [], rankings: [],
};
let activeQuery;
let catalogCalls = 0;
global.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== PRECO_POPULAR_BASE_URL || url.pathname !== "/api/catalog_system/pub/products/search") {
    throw new Error("Unexpected network destination blocked");
  }
  if (catalogCalls >= maxCalls) throw new Error("Catalog request budget exceeded");
  catalogCalls++;
  if (extended) await new Promise((resolve) => setTimeout(resolve, delayMs));
  const trace = { query: activeQuery, method: "GET", endpoint: url.toString() };
  report.requests.push(trace);
  const start = Date.now();
  try {
    const response = await fetchOriginal(input, init);
    trace.status = response.status;
    trace.durationMs = Date.now() - start;
    trace.resources = response.headers.get("resources") || response.headers.get("content-range");
    try {
      trace.body = await response.clone().json();
      trace.rawProducts = Array.isArray(trace.body) ? trace.body.length : null;
      trace.rawSkus = Array.isArray(trace.body)
        ? trace.body.reduce((sum, product) => sum + (product.items?.length || 0), 0) : null;
      trace.bodyReadDurationMs = Date.now() - start;
    } catch {
      trace.responseIsJson = false;
      trace.responseText = (await response.clone().text()).slice(0, 2000);
    }
    return response;
  } catch (error) {
    trace.durationMs = Date.now() - start;
    trace.error = { name: error.name, message: error.message, cause: error.cause?.code };
    throw error;
  }
};

const selector = new CommercialMedicineSelector();
const rank = selector.rankCommercialOptions.bind(selector);
selector.rankCommercialOptions = (...args) => {
  const result = rank(...args);
  report.rankings.push({ query: activeQuery, parsed: selector.parseMedicineQuery(args[0]),
    candidates: args[1], scored: result.scored, selected: result.selected });
  return result;
};
const provider = new PrecoPopularService({ get: (name) => name === "PRECO_POPULAR_ENABLED" ? enabled : undefined }, selector, {
  record: async (event) => { report.providerEvents.push({ ...event }); },
});
const normalize = provider.normalizeProducts.bind(provider);
provider.normalizeProducts = (body) => {
  const result = normalize(body);
  report.normalizations.push({ query: activeQuery, discarded: result.discarded, products: result.products });
  return result;
};
const priorityRules = new MedicinePriorityRulesService({ safePrismaCall: async () => [] }, selector);
const orchestrator = new MedicineSearchOrchestratorService(selector, {}, priorityRules, provider);
const cases = extended ? [...medicines, ...variations] : ["dipirona", "novalgina", "dorflex", "neosoro", "ibuprofeno", "venvanse", "allegra", "amoxicilina",
  "dipirona 1g", "dipirona 1000mg", "venvanse 50mg", "venvanse 70mg"];

async function run() {
  report.enabled = provider.isEnabled();
  if (!report.enabled) throw new Error("PRECO_POPULAR_ENABLED is disabled in the local configuration");
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
  for (const query of cases.slice(startIndex)) {
    activeQuery = query;
    const start = Date.now();
    const before = catalogCalls;
    const requestStart = report.requests.length;
    const summary = await orchestrator.searchMedicine(query);
    // Reuses the same provider cache; no additional detail request per product.
    const catalog = await provider.searchMedicines(query);
    const options = (summary?.options || []).map((item) => ({
      name: item.label, dosage: item.strength, form: item.formGroup, package: item.packageDescription,
      price: item.pricePf, brand: item.brand, ean: item.ean, imageUrl: item.imageUrl,
      sourceId: item.sourceId, reason: item.selectionReason,
      rawName: catalog.find((candidate) => candidate.sourceId === item.sourceId)?.productName,
      activeIngredient: catalog.find((candidate) => candidate.sourceId === item.sourceId)?.activeIngredient,
    }));
    const keys = options.map((item) => [item.dosage, item.form, item.package].join("|"));
    const parsed = selector.parseMedicineQuery(query);
    const checks = {
      found: options.length > 0,
      allPricesValid: options.length > 0 && options.every((item) => Number.isFinite(item.price) && item.price > 0),
      allHaveImageUrl: options.length > 0 && options.every((item) => Boolean(item.imageUrl)),
      allHaveEan: options.length > 0 && options.every((item) => Boolean(item.ean)),
      duplicatePresentations: keys.filter((key, index) => keys.indexOf(key) !== index),
      duplicateDisplayNames: options.map((item) => item.name).filter((name, index, names) => names.indexOf(name) !== index),
      missingDosages: options.filter((item) => !item.dosage).map((item) => item.sourceId),
      unknownForms: options.filter((item) => item.form === "outro").map((item) => item.sourceId),
      fullCatalogPrices: options.length > 0 && options.every((item) => {
        const source = catalog.find((candidate) => candidate.sourceId === item.sourceId);
        return source && Math.abs(source.priceConsumer - item.price) < 0.005;
      }),
      requestedDoseMatches: parsed.dosageMg === undefined ? null : options.length > 0 && options.every((item) =>
        selector.parseMedicineQuery(item.dosage || "").dosageMg === parsed.dosageMg),
    };
    const requests = report.requests.slice(requestStart);
    const result = { query, kind: extended && medicines.includes(query) ? "medicine" : "variation",
      parsed, httpCalls: catalogCalls - before, durationMs: Date.now() - start,
      httpStatuses: requests.map((item) => item.status ?? null),
      rawProducts: requests.reduce((sum, item) => sum + (item.rawProducts || 0), 0),
      normalizedMedicineCount: catalog.length, normalizedDosages: [...new Set(catalog.map((item) => item.dosage))],
      options, checks };
    report.queries.push(result);
    console.log(JSON.stringify(extended ? { index: startIndex + report.queries.length, query, calls: result.httpCalls,
      statuses: result.httpStatuses, raw: result.rawProducts, normalized: catalog.length,
      selected: options.map((item) => ({ name: item.name, dose: item.dosage, price: item.price })),
      checks } : result));
    // Do not spend the budget repeating a rate-limited/blocked service.
    if (requests.some((item) => item.error || item.status >= 400) || report.providerEvents.at(-1)?.outcome === "FAILED") {
      report.stoppedEarly = "Provider request failed; no retry storm";
      break;
    }
  }

  const urls = [...new Set(report.queries.flatMap((query) => query.options.map((option) => option.imageUrl)).filter(Boolean))].slice(0, 2);
  for (const url of urls) {
    const check = { url, method: "HEAD" };
    const started = Date.now();
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".vtexassets.com") && !parsed.hostname.endsWith(".vteximg.com.br")) {
        check.skipped = "Image host outside diagnostic allowlist";
      } else {
        const response = await fetchOriginal(url, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(8000) });
        check.status = response.status;
        check.contentType = response.headers.get("content-type");
        check.contentLength = response.headers.get("content-length");
      }
    } catch (error) { check.error = error.message; }
    check.durationMs = Date.now() - started;
    report.imageChecks.push(check);
  }
}

run().catch((error) => {
  report.error = { name: error.name, message: error.message };
  process.exitCode = 1;
}).finally(() => {
  global.fetch = fetchOriginal;
  report.finishedAt = new Date().toISOString();
  report.catalogHttpCalls = catalogCalls;
  report.maxCatalogHttpCalls = maxCalls;
  const directory = path.join(root, "diagnostics");
  fs.mkdirSync(directory, { recursive: true });
  const output = path.join(directory, `live-catalog-${extended ? "50-" : ""}${report.startedAt.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(output, JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ output, catalogHttpCalls: catalogCalls, queries: report.queries.length,
    imageChecks: report.imageChecks, stoppedEarly: report.stoppedEarly, error: report.error }));
});
