// Explicit, bounded live probes. No application bootstrap, database, orders or WhatsApp.
const fs = require('node:fs');
const path = require('node:path');
const { Logger } = require('@nestjs/common');
const { CommercialMedicineSelector } = require('../dist/integrations/commercial-medicine-selector');
const { PrecoPopularService } = require('../dist/integrations/preco-popular.service');
const { MedicineSearchOrchestratorService } = require('../dist/integrations/medicine-search-orchestrator.service');
const { ProductSearchOrchestratorService } = require('../dist/integrations/product-search-orchestrator.service');
const { ManualRetailProductService } = require('../dist/integrations/manual-retail-product.service');
const { PharmaDbAuthService } = require('../dist/integrations/pharmadb-auth.service');

async function main() {
  if (!process.argv.includes('--live')) throw new Error('Requires --live');
  Logger.overrideLogger(false);
  const report = { at: new Date().toISOString(), requests: [], results: [], backups: [] };
  const originalFetch = global.fetch;
  global.fetch = async (input, init) => {
    const url = new URL(input);
    if (report.requests.length >= 12 || url.origin !== 'https://www.precopopular.com.br' || url.pathname !== '/api/catalog_system/pub/products/search') throw new Error('Probe allowlist/budget');
    const response = await originalFetch(input, { ...init, redirect: 'error' });
    const data = response.ok ? await response.clone().json() : [];
    report.requests.push({ term: url.searchParams.get('ft'), http: response.status, count: Array.isArray(data) ? data.length : null,
      names: Array.isArray(data) ? data.slice(0, 4).map(p => p.productName) : [] });
    return response;
  };
  try {
    const selector = new CommercialMedicineSelector(), config = { get: () => undefined };
    const provider = new PrecoPopularService(config, selector);
    const medicine = new MedicineSearchOrchestratorService(selector, {}, { getRulesForPrinciple: async () => [] }, provider);
    const retail = new ProductSearchOrchestratorService(new ManualRetailProductService(), provider);
    const queries = process.argv.includes('--focused') ? ['Olina grande', 'Absorventes sempre livres'] : ['Colirio maxidex', 'Metronidazol (pomada)', 'Ozivy 1mg solucao injetavel', 'Amoxicilina com clavulanato 875mg', 'Olina grande', 'Tadalafila 20ml', 'Absorvente sempre livre com16 unidades', 'Absorventes sempre livres'];
    for (const query of queries) {
      const result = /absorvente/i.test(query) ? await retail.searchProducts(query) : await medicine.searchMedicine(query);
      const row = { query, status: result.searchStatus, selected: result.options.map(o => ({ name: o.label, price: o.pricePf, strength: o.strength, form: o.formGroup })) };
      report.results.push(row); console.log(JSON.stringify(row));
      if (report.requests.some(r => r.http >= 400)) break;
    }
  } finally { global.fetch = originalFetch; }
  if (process.argv.includes('--backups')) {
    const env = require('dotenv').parse(fs.readFileSync(path.join(__dirname, '..', '.env')));
    const config = { get: key => key === 'PHARMADB_API_BASE_URL' ? 'https://api.pharmadb.com.br/v1' : env[key] };
    const auth = new PharmaDbAuthService(config);
    const token = await auth.getAccessToken();
    report.backups.push({ provider: 'pharmadb', authenticated: !!token, status: auth.getFailureStatus() ?? null });
    try {
      const response = await originalFetch('https://bulapi.com.br/api/v1/search?q=dipirona', { redirect: 'error', signal: AbortSignal.timeout(5000) });
      report.backups.push({ provider: 'bulapi', status: response.status });
    } catch (error) { report.backups.push({ provider: 'bulapi', status: null, error: error.name }); }
    console.log(JSON.stringify({ backups: report.backups }));
  }
  const file = path.join(__dirname, '..', 'diagnostics', `history-fixes-${report.at.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(`Report: ${file}; primary HTTP requests: ${report.requests.length}`);
}
main().catch(error => { console.error(error.name, error.message); process.exitCode = 1; });
