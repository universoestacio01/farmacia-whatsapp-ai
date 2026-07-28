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
  DEFAULT_MEDICINE_PRIORITY_RULES,
} = require("../dist/config/medicine-priority-rules.config");

loadEnv();

const selector = new CommercialMedicineSelector();
const config = { get: (name) => process.env[name] };
const auth = new PharmaDbAuthService(config);
const pharmaDb = new PharmaDbService(config, auth, selector);
const bulaApi = { lookupMedicine: async () => null };
const manual = { search: async () => [], findSymptomOptions: () => null };
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

const queries = [
  "10 tadala de 20",
  "cloridrato de fexofenadina",
  "allegra",
  "cloridrato de ciprofloxacina",
  "plenance de 10 mg",
  "clonazepam",
  "diurix",
  "viagra",
];

async function run() {
  console.log(
    `PHARMADB_API_KEY configured=${Boolean(process.env.PHARMADB_API_KEY)} length=${process.env.PHARMADB_API_KEY?.length || 0}`,
  );

  for (const query of queries) {
    const parsed = selector.parseMedicineQuery(query);
    const result = await orchestrator.searchMedicine(query);

    console.log(
      JSON.stringify({
        query,
        parsed: {
          medicineName: parsed.medicineName,
          canonicalName: parsed.canonicalName,
          dosage: parsed.dosage,
          quantity: parsed.quantity,
        },
        found: Boolean(result && result.options.length > 0),
        options: result?.options.length || 0,
        first: result?.options[0]?.label || null,
      }),
    );
  }
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
  console.error(error);
  process.exitCode = 1;
});
