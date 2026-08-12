const fs = require("node:fs");

const {
  CommercialMedicineSelector,
} = require("../dist/integrations/commercial-medicine-selector");
const { PharmaDbAuthService } = require("../dist/integrations/pharmadb-auth.service");
const { PharmaDbService } = require("../dist/integrations/pharmadb.service");
const {
  MedicineSearchOrchestratorService,
} = require("../dist/integrations/medicine-search-orchestrator.service");
const {
  PopularManualMedicineService,
} = require("../dist/integrations/popular-manual-medicine.service");
const {
  DEFAULT_MEDICINE_PRIORITY_RULES,
} = require("../dist/config/medicine-priority-rules.config");

loadEnv();

const selector = new CommercialMedicineSelector();
const config = { get: (name) => process.env[name] };
const auth = new PharmaDbAuthService(config);
const pharmaDb = new PharmaDbService(config, auth, selector);
const bulaApi = { lookupMedicine: async () => null };
const manual = new PopularManualMedicineService(selector);
const priorityRules = {
  getRulesForPrinciple: async (principle) =>
    DEFAULT_MEDICINE_PRIORITY_RULES.filter(
      (rule) => rule.principleActive === principle,
    ),
};
const orchestrator = new MedicineSearchOrchestratorService(
  config,
  selector,
  pharmaDb,
  bulaApi,
  manual,
  priorityRules,
);

const queries = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["dipirona", "dipirona 1g", "ibuprofeno", "paracetamol", "venvanse"];

async function run() {
  console.log(
    `PHARMADB_API_KEY configured=${Boolean(process.env.PHARMADB_API_KEY)} length=${process.env.PHARMADB_API_KEY?.length || 0}`,
  );

  if (!process.env.PHARMADB_API_KEY) {
    throw new Error("PHARMADB_API_KEY ausente no ambiente local");
  }

  for (const query of queries) {
    const parsed = selector.parseMedicineQuery(query);
    const providerQuery = parsed.medicineName || parsed.canonicalName || query;
    const raw = await pharmaDb.search(providerQuery);
    const result = await orchestrator.searchMedicine(query);

    console.log(
      JSON.stringify({
        query,
        providerQuery,
        pharmaDbResults: raw.length,
        pharmaDbDosages: distinct(raw.map((item) => item.dosage).filter(Boolean)),
        finalOptions: (result?.options || []).map((option) => ({
          label: option.label,
          strength: option.strength,
          package: option.packageDescription,
          source: option.source,
        })),
      }),
    );
  }
}

function distinct(values) {
  return [...new Set(values)];
}

function loadEnv() {
  if (!fs.existsSync(".env")) {
    return;
  }

  for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);

    if (!match || process.env[match[1]]) {
      continue;
    }

    process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
