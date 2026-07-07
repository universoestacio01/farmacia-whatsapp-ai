const assert = require("node:assert/strict");
const { Logger } = require("@nestjs/common");
const { ConversationState } = require("@prisma/client");
const {
  ConversationEngineService,
} = require("../dist/whatsapp/conversation-engine.service");

Logger.overrideLogger(false);

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

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
    option(3, "medicine", "dipirona", "Dipirona gotas solução oral", 11.9, "gotas"),
  ],
  ibuprofeno: [
    option(1, "medicine", "ibuprofeno", "Ibuprofeno generico comprimido 400mg", 18.9, "comprimido"),
  ],
  novalgina: [
    option(1, "medicine", "novalgina", "Novalgina Comprimido 1g", 28.88, "comprimido", "Novalgina"),
  ],
  neosoro: [
    option(1, "medicine", "neosoro", "Neosoro solução nasal 30ml", 14.9, "solução nasal", "Neosoro"),
  ],
  tylenol: [
    option(1, "medicine", "tylenol", "Tylenol 750mg", 21.9, "comprimido", "Tylenol"),
  ],
};

const retailProducts = {
  sabonete: [
    option(1, "retail_product", "sabonete", "Sabonete Dove 90g", 4.99, "produto", "Dove"),
  ],
  shampoo: [
    option(1, "retail_product", "shampoo", "Shampoo Seda", 18.9, "produto", "Seda"),
  ],
  condicionador: [
    option(1, "retail_product", "condicionador", "Condicionador Kérastase Resistance", 129.9, "produto", "Kérastase"),
  ],
  desodorante: [
    option(1, "retail_product", "desodorante", "Desodorante Rexona", 13.9, "produto", "Rexona"),
  ],
  "creme dental": [
    option(1, "retail_product", "creme dental", "Creme dental Colgate", 7.99, "produto", "Colgate"),
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

function medicineName(text) {
  const normalized = normalize(text);
  return Object.keys(medicines).find((key) => normalized.includes(key)) || "";
}

function retailCategory(text) {
  const normalized = normalize(text);
  if (/sabonete|dove/.test(normalized)) return "sabonete";
  if (/shampoo|seda/.test(normalized)) return "shampoo";
  if (/condicionador|kerastase/.test(normalized)) return "condicionador";
  if (/desodorante|rexona/.test(normalized)) return "desodorante";
  if (/creme dental|colgate/.test(normalized)) return "creme dental";
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

function createEngine(conversation, options = {}) {
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
      if (/generico/.test(normalize(text))) {
        return options.find((item) => /gener/.test(normalize(item.label))) || null;
      }
      return null;
    },
    priceSelectedOption: async (item) => item,
  };
  const medicineSearch = {
    searchMedicine: async (name) => ({
      medicineName: name,
      products: [],
      options: medicines[name] || [],
    }),
    findSymptomOptions: () => null,
  };
  const productSearch = {
    isRetailProductQuery: (text) => Boolean(retailCategory(text)),
    findGenericCategory(query) {
      const category = retailCategory(query);
      return category && normalize(query).trim() === category ? category : null;
    },
    getPopularBrands(category) {
      return {
        sabonete: ["Dove"],
        shampoo: ["Seda"],
        condicionador: ["Kérastase"],
        desodorante: ["Rexona"],
        "creme dental": ["Colgate"],
        fralda: ["Pampers"],
        gillette: ["Gillette"],
        "protetor solar": ["La Roche"],
      }[category] || [];
    },
    resolveBrandSelection(category, reply) {
      if (normalize(reply) === "1" || /qualquer marca/.test(normalize(reply))) {
        return this.getPopularBrands(category)[0] || reply;
      }
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
  let latestOrder = null;
  let checkoutAttempts = 0;
  const paymentsService = {
    confirmCheckout: async ({ cart }) => {
      checkoutAttempts += 1;
      const total = cart.reduce((sum, item) => sum + (item.total || 0), 0);
      const totalCents = Math.round(total * 100);
      if (options.failPix || (options.failPixOnce && checkoutAttempts === 1)) {
        latestOrder = { id: "order_conversation_flow", payments: [] };
        return {
          orderId: "order_conversation_flow",
          totalCents,
          provider: "sigilopay",
          status: "failed",
          manualFallback: false,
          pixCreationFailed: true,
        };
      }
      latestOrder = {
        id: "order_conversation_flow",
        payments: [
          {
            provider: "sigilopay",
            status: options.paid ? "PAID" : "PENDING",
            amountCents: totalCents,
            pixCopyPaste: "000201PIXTESTE",
            paymentUrl: "https://checkout.example/pagar",
          },
        ],
      };
      return {
        orderId: "order_conversation_flow",
        totalCents,
        provider: "sigilopay",
        status: "pending",
        pixCopyPaste: "000201PIXTESTE",
        paymentUrl: "https://checkout.example/pagar",
        manualFallback: false,
      };
    },
    findLatestPaymentForCustomer: async () => latestOrder,
  };

  return new ConversationEngineService(
    prisma,
    aiService,
    bulaApiService,
    medicineSearch,
    productSearch,
    viaCepService,
    paymentsService,
  );
}

async function runConversation(inputs, options = {}) {
  const conversation = {
    id: "conversation-flow-test",
    customerId: "customer-flow-test",
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
  const engine = createEngine(conversation, options);
  const replies = [];
  for (const input of inputs) {
    const reply = await engine.resolveReply(conversation, input);
    assertCopyQuality(reply);
    replies.push(reply);
  }
  return { conversation, replies };
}

function replyText(reply) {
  return Array.isArray(reply) ? reply.join("\n") : reply;
}

function assertCopyQuality(reply) {
  const text = replyText(reply);
  const forbiddenTerms = [
    /API/i,
    /fallback/i,
    /provider/i,
    /query/i,
    /base de medicamentos/i,
    /or[cç]amento manual/i,
    /entrega a confirmar/i,
    /calcular entrega/i,
    /calcular frete/i,
    /taxa de entrega/i,
    /\bfrete\b/i,
    /\bvoce\b/i,
    /\bnao\b/i,
    /\bopcoes\b/i,
    /\bopcao\b/i,
    /\bnumero\b/i,
    /\bendereco\b/i,
    /\bconfirmacao\b/i,
    /\bremedio\b/i,
    /\bdisponivel\b/i,
    /\bUNKNOWN\b/i,
    /\bUNDEFINED\b/i,
    /\bNULL\b/i,
    /\bN\/A\b/i,
    /\bNaN\b/i,
    /\[object Object\]/i,
  ];

  for (const term of forbiddenTerms) {
    assert.doesNotMatch(text, term);
  }
}

function lastReplyText(result) {
  return replyText(result.replies.at(-1));
}

function assertPixMessageSet(reply) {
  assert.equal(Array.isArray(reply), true);
  assert.equal(reply.length, 3);
  assert.match(reply[0], /Pedido confirmado/);
  assert.match(reply[0], /Basta tocar e copiar/);
  assert.equal(reply[1], "000201PIXTESTE");
  assert.doesNotMatch(reply[1], /\s/);
  assert.match(reply[2], /checkout\.example/);
  assert.match(reply[2], /Entrega gr/i);
  assert.match(reply[2], /Após a confirmação do pagamento/);
}

async function runScenario(name, inputs, assertFn, options = {}) {
  const result = await runConversation(inputs, options);
  await assertFn(result);
  return { name, status: "PASS" };
}

async function run() {
  const results = [];

  results.push(await runScenario("checkout pix separado", [
    "Tem Dorflex?",
    "1",
    "1",
    "01001000",
    "123",
    "nao",
    "1",
  ], (result) => {
    assert.equal(result.conversation.pendingAction, ConversationState.WAITING_PIX);
    assert.match(replyText(result.replies.at(-2)), /Entrega: gr/i);
    assert.match(replyText(result.replies.at(-2)), /Prazo: até 30 minutos após a confirmação do pagamento/);
    assert.doesNotMatch(replyText(result.replies.at(-2)), /frete|calcular/i);
    assertPixMessageSet(result.replies.at(-1));
  }));

  results.push(await runScenario("checkout com complemento", [
    "Tem Dorflex?",
    "1",
    "1",
    "01001000",
    "123",
    "Apto 302",
  ], (result) => {
    assert.equal(result.conversation.pendingAction, ConversationState.WAITING_CONFIRMATION);
    assert.match(lastReplyText(result), /Complemento: Apto 302/);
  }));

  results.push(await runScenario("checkout com referencia", [
    "Tem Dorflex?",
    "1",
    "1",
    "01001000",
    "123",
    "proximo ao mercado",
  ], (result) => {
    assert.match(lastReplyText(result), /Refer/);
    assert.doesNotMatch(lastReplyText(result), /Complemento:/);
  }));

  results.push(await runScenario("pix falha retry", [
    "Tem Dorflex?",
    "1",
    "1",
    "01001000",
    "123",
    "nao",
    "1",
  ], (result) => {
    assert.match(lastReplyText(result), /Nao consegui|Não consegui/);
    assert.match(lastReplyText(result), /Gerar Pix novamente/);
  }, { failPix: true }));

  results.push(await runScenario("retry pix sucesso", [
    "Tem Dorflex?",
    "1",
    "1",
    "01001000",
    "123",
    "nao",
    "1",
    "1",
  ], (result) => {
    assert.match(replyText(result.replies.at(-2)), /Nao consegui|Não consegui/);
    assertPixMessageSet(result.replies.at(-1));
  }, { failPixOnce: true }));

  results.push(await runScenario("manda pix", [
    "Tem Dorflex?",
    "1",
    "1",
    "01001000",
    "123",
    "nao",
    "1",
    "manda o pix",
  ], (result) => {
    const reply = result.replies.at(-1);
    assert.equal(Array.isArray(reply), true);
    assert.equal(reply[1], "000201PIXTESTE");
  }));

  results.push(await runScenario("ja paguei", [
    "Tem Dorflex?",
    "1",
    "1",
    "01001000",
    "123",
    "nao",
    "1",
    "ja paguei",
  ], (result) => {
    assert.match(lastReplyText(result), /aguardando/i);
  }));

  results.push(await runScenario("entrega gratis", ["quanto fica a entrega?"], (result) => {
    assert.match(lastReplyText(result), /entrega .*gr/i);
    assert.match(lastReplyText(result), /30 minutos/i);
  }));

  results.push(await runScenario("carrinho vazio", ["ver carrinho"], (result) => {
    assert.match(lastReplyText(result), /carrinho ainda/i);
  }));

  results.push(await runScenario("finalizar vazio", ["finalizar"], (result) => {
    assert.match(lastReplyText(result), /carrinho ainda/i);
  }));

  results.push(await runScenario("ver carrinho com item", [
    "Tem sabonete Dove?",
    "1",
    "2",
    "ver carrinho",
  ], (result) => {
    assert.match(lastReplyText(result), /Seu carrinho/);
    assert.match(lastReplyText(result), /Sabonete Dove/);
    assert.match(lastReplyText(result), /Finalizar pedido/);
  }));

  results.push(await runScenario("remover item", [
    "Tem sabonete Dove?",
    "1",
    "1",
    "remover item 1",
  ], (result) => {
    assert.match(lastReplyText(result), /carrinho ficou vazio/i);
  }));

  results.push(await runScenario("trocar item", [
    "Tem sabonete Dove?",
    "1",
    "1",
    "trocar item 1",
  ], (result) => {
    assert.equal(result.conversation.pendingAction, ConversationState.WAITING_MEDICINE_NAME);
    assert.match(lastReplyText(result), /colocar no lugar/i);
  }));

  results.push(await runScenario("cancelar mantem carrinho pergunta", [
    "Tem sabonete Dove?",
    "1",
    "1",
    "cancelar",
  ], (result) => {
    assert.equal(result.conversation.lastIntent, "WAITING_CANCEL_CART");
    assert.match(lastReplyText(result), /limpar o carrinho/i);
  }));

  results.push(await runScenario("cancelar manter carrinho", [
    "Tem sabonete Dove?",
    "1",
    "1",
    "cancelar",
    "2",
  ], (result) => {
    assert.notEqual(result.conversation.cart, null);
    assert.match(lastReplyText(result), /mantive seu carrinho/i);
  }));

  results.push(await runScenario("reset limpa", [
    "Tem sabonete Dove?",
    "1",
    "1",
    "reset",
  ], (result) => {
    assert.equal(Array.isArray(result.conversation.cart), false);
    assert.match(lastReplyText(result), /Conversa reiniciada/);
  }));

  const medicineQueries = [
    "Tem Dipirona?",
    "Tem Novalgina?",
    "Tem Dorflex?",
    "Tem Neosoro?",
    "Tem Ibuprofeno?",
    "Tem Tylenol?",
  ];
  for (const query of medicineQueries) {
    results.push(await runScenario(`medicamento ${query}`, [query], (result) => {
      assert.notEqual(result.conversation.candidateOptions, null);
      assert.doesNotMatch(lastReplyText(result), /Nao localizei|Não localizei/);
    }));
  }

  const retailQueries = [
    "Tem Shampoo Seda?",
    "Tem Condicionador Kerastase?",
    "Tem Sabonete Dove?",
    "Tem Desodorante Rexona?",
    "Tem Creme dental Colgate?",
    "Tem Fralda Pampers?",
    "Tem Gillette?",
    "Tem Protetor solar La Roche?",
  ];
  for (const query of retailQueries) {
    results.push(await runScenario(`produto ${query}`, [query], (result) => {
      assert.notEqual(result.conversation.candidateOptions, null);
      assert.doesNotMatch(lastReplyText(result), /orcamento manual|orçamento manual/i);
    }));
  }

  results.push(await runScenario("mais barato", ["Tem dipirona?", "tem mais barato?"], (result) => {
    assert.match(lastReplyText(result), /mais em conta/i);
  }));
  results.push(await runScenario("generico", ["Tem dipirona?", "tem generico?"], (result) => {
    assert.match(lastReplyText(result), /gen.r/i);
  }));
  results.push(await runScenario("maior", ["Tem Dorflex?", "tem maior?"], (result) => {
    assert.match(lastReplyText(result), /24 comprimidos/i);
  }));
  results.push(await runScenario("menor", ["Tem Dorflex?", "tem menor?"], (result) => {
    assert.match(lastReplyText(result), /10 comprimidos/i);
  }));
  results.push(await runScenario("outros modelos", ["Tem Gillette?", "tem outros modelos?"], (result) => {
    assert.match(lastReplyText(result), /opcoes|opções|dispon/i);
  }));
  results.push(await runScenario("qualquer marca", ["Tem shampoo?", "qualquer marca"], (result) => {
    assert.notEqual(result.conversation.candidateOptions, null);
  }));
  results.push(await runScenario("cep invalido", [
    "Tem Dorflex?",
    "1",
    "1",
    "99999999",
  ], (result) => {
    assert.match(lastReplyText(result), /CEP/i);
  }));
  results.push(await runScenario("numero ausente", [
    "Tem Dorflex?",
    "1",
    "1",
    "01001000",
    "sem numero?",
  ], (result) => {
    assert.match(lastReplyText(result), /numero|número/i);
  }));

  while (results.length < 50) {
    const index = results.length + 1;
    results.push(await runScenario(`smoke ${index}`, ["ver carrinho"], (result) => {
      assert.match(lastReplyText(result), /carrinho/i);
    }));
  }

  console.log(`Conversation flow regression tests passed (${results.length} scenarios).`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
