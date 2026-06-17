const assert = require("node:assert/strict");
const { Logger } = require("@nestjs/common");
const { ConversationState } = require("@prisma/client");
const {
  ConversationEngineService,
} = require("../dist/whatsapp/conversation-engine.service");

Logger.overrideLogger(false);

function option(id, type, medicineName, label, price, formGroup = "produto", brand) {
  return {
    optionId: id,
    productId: id,
    presentationId: id,
    type,
    productName: label,
    medicineName,
    label,
    formGroup,
    packageDescription: label,
    pricePf: price,
    brand,
    selectionReason: "conversation-flow-test",
  };
}

const medicines = {
  dorflex: [
    option(1, "medicine", "dorflex", "Dorflex caixa com 10 comprimidos", 12.9, "comprimido", "Dorflex"),
    option(2, "medicine", "dorflex", "Dorflex Uno 1g caixa com 10 comprimidos", 16.9, "comprimido", "Dorflex"),
    option(3, "medicine", "dorflex", "Dorflex caixa com 24 comprimidos", 24.9, "comprimido", "Dorflex"),
  ],
  dipirona: [
    option(1, "medicine", "dipirona", "Novalgina Comprimido 500mg", 22, "comprimido", "Novalgina"),
    option(2, "medicine", "dipirona", "Dipirona genérica comprimido 500mg", 13, "comprimido"),
    option(3, "medicine", "dipirona", "Dipirona gotas / solução oral", 11.9, "gotas"),
  ],
};

const retailProducts = {
  sabonete: [
    option(1, "retail_product", "sabonete", "Sabonete Dove 90g", 4.99, "produto", "Dove"),
  ],
  fralda: [
    option(1, "retail_product", "fralda", "Fralda Pampers pacote G", 39.9, "produto", "Pampers"),
  ],
  gillette: [
    option(1, "retail_product", "gillette", "Gillette Prestobarba", 9.9, "produto", "Gillette"),
    option(2, "retail_product", "gillette", "Gillette Mach3", 19.9, "produto", "Gillette"),
  ],
  "protetor solar": [
    option(1, "retail_product", "protetor solar", "Protetor solar La Roche FPS 60", 79.9, "produto", "La Roche"),
  ],
};

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function medicineName(text) {
  return Object.keys(medicines).find((key) => normalize(text).includes(key)) || "";
}

function retailCategory(text) {
  const normalized = normalize(text);

  if (/sabonete|dove/.test(normalized)) return "sabonete";
  if (/fralda|pampers/.test(normalized)) return "fralda";
  if (/gillette|gilete|prestobarba/.test(normalized)) return "gillette";
  if (/protetor solar|la roche|fps/.test(normalized)) return "protetor solar";
  return null;
}

class FakePrisma {
  constructor(conversation) {
    this.conversationState = conversation;
    this.conversation = {
      update: async ({ data }) => {
        Object.assign(this.conversationState, data);
        return this.conversationState;
      },
    };
  }
}

function createEngine(conversation) {
  const prisma = new FakePrisma(conversation);
  const aiService = {
    generatePharmacyReply: async (text) => `IA fallback: ${text}`,
  };
  const bulaApiService = {
    isPriceQuestionWithoutMedicine(text) {
      return /^(qual )?(preco|valor)\??$/.test(normalize(text).trim());
    },
    detectMedicineQuestion(text) {
      const name = medicineName(text);
      if (!name) return null;
      const normalized = normalize(text);
      return {
        intent: /bula/.test(normalized)
          ? "leaflet"
          : /preco|valor/.test(normalized)
            ? "price"
            : "purchase",
        medicineName: name,
      };
    },
    extractMedicineName: medicineName,
    normalizeMedicineName: medicineName,
    optionBelongsToMedicine(query, item) {
      return !query || normalize(item.medicineName).includes(normalize(query));
    },
    formatPriceReply(summary) {
      return `Preço de ${summary.medicineName}`;
    },
    formatPresentationChoiceReply(summary) {
      return `Opções de ${summary.medicineName}`;
    },
    findOptionByReply(text, options) {
      const normalized = normalize(text);
      if (/generico/.test(normalized)) {
        return options.find((item) => /gener/.test(normalize(item.label))) || null;
      }
      return null;
    },
    priceSelectedOption: async (item) => item,
  };
  const medicineSearch = {
    searchMedicine: async (name) => ({
      medicineName: name,
      products: medicines[name] || [],
      options: medicines[name] || [],
    }),
    findSymptomOptions: () => null,
  };
  const productSearch = {
    isRetailProductQuery: (text) => Boolean(retailCategory(text)),
    findGenericCategory(query) {
      const normalized = normalize(query);
      return ["sabonete", "fralda", "gillette", "protetor solar"].includes(normalized)
        ? normalized
        : null;
    },
    getPopularBrands(category) {
      return {
        sabonete: ["Dove"],
        fralda: ["Pampers"],
        gillette: ["Gillette"],
        "protetor solar": ["La Roche"],
      }[category] || [];
    },
    resolveBrandSelection(category, reply) {
      if (normalize(reply) === "1") return this.getPopularBrands(category)[0];
      return reply;
    },
    buildQueryFromBrandSelection(category, brand) {
      return `${category} ${brand}`;
    },
    searchProducts: async (query) => {
      const category = retailCategory(query);
      return {
        query,
        category,
        requestedBrand: retailProducts[category]?.[0]?.brand,
        options: retailProducts[category] || [],
      };
    },
  };
  const viaCepService = {
    findAddressByCep: async (cep) =>
      cep === "01001000"
        ? {
            cep,
            logradouro: "Praça da Sé",
            bairro: "Sé",
            localidade: "São Paulo",
            uf: "SP",
          }
        : null,
  };

  return new ConversationEngineService(
    prisma,
    aiService,
    bulaApiService,
    medicineSearch,
    productSearch,
    viaCepService,
  );
}

async function runConversation(inputs) {
  const conversation = {
    id: "conversation-flow-test",
    pendingAction: ConversationState.IDLE,
    lastIntent: null,
    lastMedicine: null,
    currentMedicineQuery: null,
    currentRetailCategory: null,
    candidateOptions: null,
    selectedPresentation: null,
    cart: null,
    pendingAddress: null,
  };
  const engine = createEngine(conversation);
  const replies = [];

  for (const input of inputs) {
    replies.push(await engine.resolveReply(conversation, input));
  }

  return { conversation, replies };
}

async function run() {
  let result = await runConversation([
    "Tem Dorflex?",
    "1",
    "1",
    "01001000",
    "123",
    "1",
  ]);
  assert.equal(result.conversation.pendingAction, ConversationState.WAITING_PIX);
  assert.match(result.replies.at(-1), /Pedido confirmado/);

  result = await runConversation(["ver carrinho"]);
  assert.match(result.replies[0], /carrinho ainda está vazio/i);

  result = await runConversation(["finalizar"]);
  assert.match(result.replies[0], /carrinho ainda está vazio/i);

  result = await runConversation(["Tem sabonete Dove?", "1", "2", "ver carrinho"]);
  assert.match(result.replies.at(-1), /Seu carrinho/);
  assert.match(result.replies.at(-1), /Sabonete Dove/);

  result = await runConversation(["Tem dipirona?", "tem mais barato?"]);
  assert.match(result.replies.at(-1), /menor valor/i);
  assert.match(result.replies.at(-1), /Dipirona gotas/i);

  result = await runConversation(["Tem Dorflex?", "qual você recomenda?"]);
  assert.match(result.replies.at(-1), /mais indicada/i);

  result = await runConversation(["Tem dipirona?", "tem genérico?"]);
  assert.match(result.replies.at(-1), /genérica/i);

  result = await runConversation(["Tem Dorflex?", "tem maior?"]);
  assert.match(result.replies.at(-1), /24 comprimidos/i);

  result = await runConversation(["Tem Dorflex?", "tem menor?"]);
  assert.match(result.replies.at(-1), /10 comprimidos/i);

  result = await runConversation(["Tem Dorflex?", "tem similar?"]);
  assert.equal(result.conversation.pendingAction, ConversationState.WAITING_PRESENTATION);
  assert.match(result.replies.at(-1), /opções disponíveis/i);

  result = await runConversation(["Tem sabonete Dove?", "1", "quero trocar"]);
  assert.equal(result.conversation.pendingAction, ConversationState.WAITING_PRESENTATION);
  assert.equal(Array.isArray(result.conversation.cart) ? result.conversation.cart.length : 0, 0);

  result = await runConversation(["Tem Dorflex?", "1", "voltar"]);
  assert.equal(result.conversation.pendingAction, ConversationState.WAITING_PRESENTATION);
  assert.match(result.replies.at(-1), /opções disponíveis/i);

  result = await runConversation([
    "Tem sabonete Dove?",
    "1",
    "1",
    "remover item 1",
  ]);
  assert.match(result.replies.at(-1), /carrinho ficou vazio/i);

  result = await runConversation([
    "Tem sabonete Dove?",
    "1",
    "1",
    "trocar item 1",
  ]);
  assert.equal(result.conversation.pendingAction, ConversationState.WAITING_MEDICINE_NAME);
  assert.match(result.replies.at(-1), /colocar no lugar/i);

  result = await runConversation(["Tem fralda Pampers?"]);
  assert.match(result.replies[0], /tamanho de fralda/i);

  result = await runConversation(["Tem protetor solar La Roche?"]);
  assert.match(result.replies[0], /Qual FPS/i);

  result = await runConversation(["Tem Gillette?"]);
  assert.doesNotMatch(result.replies[0], /Gillette Gillette/);

  result = await runConversation(["Bula da dipirona"]);
  assert.equal(result.conversation.pendingAction, ConversationState.IDLE);
  assert.match(result.replies[0], /não envio a bula completa/i);

  console.log("Conversation flow regression tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
