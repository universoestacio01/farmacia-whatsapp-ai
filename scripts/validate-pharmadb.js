const fs = require("node:fs");
const path = require("node:path");

const {
  CommercialMedicineSelector,
} = require("../dist/integrations/commercial-medicine-selector");
const {
  MedicineSearchOrchestratorService,
} = require("../dist/integrations/medicine-search-orchestrator.service");
const {
  PharmaDbAuthService,
} = require("../dist/integrations/pharmadb-auth.service");
const {
  PharmaDbService,
} = require("../dist/integrations/pharmadb.service");
const {
  PopularManualMedicineService,
} = require("../dist/integrations/popular-manual-medicine.service");

function loadEnvValue(name) {
  for (const file of [".env", ".env.local", ".env.example"]) {
    const filePath = path.join(process.cwd(), file);

    if (!fs.existsSync(filePath)) {
      continue;
    }

    const line = fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .find((item) => item.match(new RegExp(`^\\s*${name}\\s*=`)));

    if (!line) {
      continue;
    }

    const value = line
      .replace(new RegExp(`^\\s*${name}\\s*=\\s*`), "")
      .trim()
      .replace(/^["']|["']$/g, "");

    if (value) {
      return value;
    }
  }

  return process.env[name] || "";
}

function configService() {
  const values = {
    PHARMADB_API_BASE_URL:
      loadEnvValue("PHARMADB_API_BASE_URL") ||
      "https://api.pharmadb.com.br/v1",
    PHARMADB_API_KEY: loadEnvValue("PHARMADB_API_KEY"),
    PHARMADB_PMC_PRICE_MULTIPLIER:
      loadEnvValue("PHARMADB_PMC_PRICE_MULTIPLIER") || "0.5",
    MEDICINE_PRIMARY_PROVIDER:
      loadEnvValue("MEDICINE_PRIMARY_PROVIDER") || "pharmadb",
  };

  return {
    get(key) {
      return values[key];
    },
  };
}

function safeFieldSnapshot(option) {
  return {
    source: option.source,
    productName: option.productName,
    displayName: option.displayName,
    activeIngredient: option.activeIngredient,
    substance: option.substance,
    laboratory: option.laboratory,
    manufacturer: option.manufacturer,
    presentation: option.presentation,
    form: option.form,
    dosage: option.dosage,
    packageInfo: option.packageInfo,
    regulatoryCategory: option.regulatoryCategory,
    anvisaRegister: option.anvisaRegister,
    ean: option.ean,
    priceFactory: option.priceFactory,
    priceConsumer: option.priceConsumer,
    pmcWithIcms: option.pmcWithIcms,
  };
}

async function main() {
  const config = configService();
  const apiKey = config.get("PHARMADB_API_KEY");

  if (!apiKey) {
    throw new Error("PHARMADB_API_KEY nao encontrada em .env/.env.local/.env.example");
  }

  console.log(`PHARMADB_API_KEY carregada com segurança; tamanho=${apiKey.length}`);

  const selector = new CommercialMedicineSelector();
  const auth = new PharmaDbAuthService(config);
  const pharma = new PharmaDbService(config, auth, selector);
  const manual = new PopularManualMedicineService(selector);
  const bula = {
    async lookupMedicine(query) {
      console.log(`BULAPI_FALLBACK_CHAMADO ${query}`);
      return null;
    },
  };
  const orchestrator = new MedicineSearchOrchestratorService(
    config,
    selector,
    pharma,
    bula,
    manual,
  );

  const token1 = await auth.getAccessToken();

  if (!token1) {
    throw new Error("Falha ao autenticar na PharmaDB");
  }

  console.log(`AUTH_OK tokenLength=${token1.length}`);

  const token2 = await auth.getAccessToken();
  console.log(`TOKEN_CACHE_OK sameToken=${token1 === token2}`);

  auth.accessToken = "invalid.jwt.for.retry";
  auth.expiresAt = Date.now() + 300000;
  const retryOptions = await pharma.search("dorflex");
  console.log(`TOKEN_401_RETRY_OK resultsAfterRetry=${retryOptions.length}`);

  const terms = [
    "Dorflex",
    "Neosoro",
    "Torsilax",
    "Cimegripe",
    "Novalgina",
    "Ibuprofeno",
  ];

  for (const term of terms) {
    const rawOptions = await pharma.search(term);
    const summary = await orchestrator.searchMedicine(term);
    const selected = summary?.options || [];
    const first = rawOptions[0];
    const selectedFirst = selected[0];

    console.log(`\n=== ${term} ===`);
    console.log(`RAW_NORMALIZED_COUNT ${rawOptions.length}`);
    console.log(
      `FIELDS pf=${rawOptions.some((item) => item.priceFactory !== undefined)} pmc=${rawOptions.some((item) => item.priceConsumer !== undefined || item.pmcWithIcms !== undefined)} laboratorio=${rawOptions.some((item) => item.laboratory || item.manufacturer)} apresentacao=${rawOptions.some((item) => item.presentation)} ean=${rawOptions.some((item) => item.ean)} anvisa=${rawOptions.some((item) => item.anvisaRegister)}`,
    );
    console.log(`SELECTED_COUNT ${selected.length}`);

    if (selectedFirst) {
      console.log(
        `SELECTED_FIRST ${JSON.stringify({
          label: selectedFirst.label,
          packageDescription: selectedFirst.packageDescription,
          price: selectedFirst.pricePf,
          formGroup: selectedFirst.formGroup,
          selectionReason: selectedFirst.selectionReason,
        })}`,
      );
    }

    if (first) {
      console.log(`NORMALIZED_EXAMPLE ${JSON.stringify(safeFieldSnapshot(first))}`);
    }
  }
}

main().catch((error) => {
  console.error(`VALIDATION_FAILED ${error.message}`);
  process.exitCode = 1;
});
