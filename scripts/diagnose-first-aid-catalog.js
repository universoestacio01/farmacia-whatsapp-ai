// Read-only, fixed-budget public catalog checks. No env, bootstrap, DB or messages.
const fs = require("node:fs");
const path = require("node:path");
const { Logger } = require("@nestjs/common");
const { PrecoPopularService } = require("../dist/integrations/preco-popular.service");
const { CommercialMedicineSelector } = require("../dist/integrations/commercial-medicine-selector");
const { ManualRetailProductService } = require("../dist/integrations/manual-retail-product.service");
const { PRECO_POPULAR_BASE_URL } = require("../dist/config/preco-popular.config");
Logger.overrideLogger(false);
const provider = new PrecoPopularService({ get: () => undefined }, new CommercialMedicineSelector());
const routing = new ManualRetailProductService();
const queries = ["soro fisiologico", "gaze", "esparadrapo", "alcool 70", "termometro", "agua oxigenada"];
const report = { capturedAt: new Date().toISOString(), baseUrl: PRECO_POPULAR_BASE_URL, requests: [] };
async function run() {
  for (const query of queries) {
    const url = `${PRECO_POPULAR_BASE_URL}/api/catalog_system/pub/products/search?ft=${encodeURIComponent(query)}&_from=0&_to=49`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: "error", headers: { Accept: "application/json", "User-Agent": "farmacia-whatsapp-ai/1.0" } });
    const entry = { query, url, status: response.status, range: response.headers.get("resources") };
    report.requests.push(entry);
    if (!response.ok) throw new Error(`Catalog HTTP ${response.status}; stopping without retries`);
    const body = await response.json();
    if (!Array.isArray(body)) throw new Error("Unexpected catalog format");
    // Retain only public contract fields used by the adapter, not marketing HTML.
    entry.body = body.map((p) => ({ productId: p.productId, productName: p.productName, brand: p.brand,
      categories: p.categories, "Princípio Ativo": p["Princípio Ativo"], items: p.items?.map((i) => ({
        itemId: i.itemId, name: i.name, nameComplete: i.nameComplete, ean: i.ean, images: i.images?.map(({imageUrl}) => ({imageUrl})),
        sellers: i.sellers?.map((s) => ({ sellerDefault: s.sellerDefault, commertialOffer: {
          Price: s.commertialOffer.Price, AvailableQuantity: s.commertialOffer.AvailableQuantity, IsAvailable: s.commertialOffer.IsAvailable,
        } })),
      })) }));
    const result = provider.normalizeProducts(entry.body);
    entry.diagnostic = { retailRoutingRecognized: routing.isRetailProductQuery(query), raw: body.length,
      valid: result.products.length, medicines: result.products.filter((p) => p.isMedicine).length,
      retail: result.products.filter((p) => !p.isMedicine).length, discarded: result.discarded };
    console.log(JSON.stringify({ query, status: entry.status, ...entry.diagnostic,
      products: result.products.map((p) => ({ id: p.skuId, name: p.name, price: p.price, category: p.category })) }));
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const url = "https://www.drogaraia.com.br/api/catalog_system/pub/products/search?ft=soro%20fisiologico&_from=0&_to=49";
  const response = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: "error", headers: { Accept: "application/json" } });
  const body = await response.text();
  let json;
  try { json = JSON.parse(body); } catch { /* HTML is not a VTEX JSON contract. */ }
  report.raiaCompatibility = { url, status: response.status, contentType: response.headers.get("content-type"), isCatalogArray: Array.isArray(json) };
  console.log(JSON.stringify({ raiaCompatibility: report.raiaCompatibility }));
}
run().catch((error) => { report.error = error.message; console.error(error.message); process.exitCode = 1; }).finally(() => {
  const output = path.join(__dirname, "fixtures", "first-aid-catalog-2026-09-23.json");
  fs.writeFileSync(output, JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ output, catalogRequests: report.requests.length, raiaChecked: Boolean(report.raiaCompatibility) }));
});
