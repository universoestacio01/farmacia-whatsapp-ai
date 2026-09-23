const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Logger } = require("@nestjs/common");
const { ConversationState: State, Prisma } = require("@prisma/client");
const { AiService } = require("../dist/ai/ai.service");
const { WhatsappMediaService } = require("../dist/whatsapp/whatsapp-media.service");
const { WhatsappService } = require("../dist/whatsapp/whatsapp.service");
const { ConversationEngineService } = require("../dist/whatsapp/conversation-engine.service");
const { CommercialMedicineSelector } = require("../dist/integrations/commercial-medicine-selector");
const { BulaApiService } = require("../dist/integrations/bula-api.service");
const { ManualRetailProductService } = require("../dist/integrations/manual-retail-product.service");
const { WhatsappCopy } = require("../dist/whatsapp/whatsapp-copy");

Logger.overrideLogger(false);
global.fetch = async () => assert.fail("Unexpected external request");
const config = (values = {}) => ({ get: (key) => values[key] });
const never = async () => assert.fail("Unexpected dependency");
const reading = { medicineName: "Venvanse", dosage: "50mg", form: "capsula", confidence: 0.98 };
const image = { id: "wamid.offline", from: "5500000000000", type: "image", image: { id: "123456", mime_type: "image/jpeg" } };
const jpeg = Buffer.from([255, 216, 255, 224, 0, 0]);
const metadata = { url: "https://lookaside.fbsbx.com/whatsapp_business/attachments?token=temporary-test", mime_type: "image/jpeg" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function aiFixture(content, values = { OPENAI_API_KEY: "test-not-a-real-key" }) {
  const ai = new AiService(config(values));
  const calls = [];
  if (ai.openai) ai.openai.chat.completions.create = async (input, options) => {
    calls.push({ input, options });
    if (content instanceof Error) throw content;
    return { choices: [{ message: { content } }] };
  };
  return { ai, calls };
}

function fixture({ analysis = { status: "identified", reading }, configured = true, state = State.WAITING_MEDICINE_NAME, media, lookup = never } = {}) {
  const conversation = {
    id: "offline-conversation", customerId: "offline-customer", pendingAction: state, lastIntent: null,
    lastMedicine: null, currentMedicineQuery: null, currentRetailCategory: null, candidateOptions: [],
    selectedPresentation: null, pendingAddress: { cep: "23860000" },
    cart: [{ name: "Sabonete Dove", type: "retail_product", quantity: 1, unitPrice: 5.19, total: 5.19,
      source: "preco_popular", pricePolicy: "preco_popular_full_v1" }],
  };
  const messages = [], replies = [], searches = [], analyses = [];
  const prisma = {
    safePrismaCall: async (_operation, callback) => callback(prisma),
    isPrismaRecoverableError: () => false,
    customer: { upsert: async () => ({ id: conversation.customerId }) },
    conversation: {
      findFirst: async () => conversation,
      update: async ({ data }) => {
        for (const [key, value] of Object.entries(data)) conversation[key] = value === Prisma.JsonNull ? null : value;
        return conversation;
      },
    },
    message: {
      findUnique: async ({ where }) => messages.find((item) => item.whatsappId === where.whatsappId) || null,
      create: async ({ data }) => { messages.push(data); return data; },
    },
  };
  const selector = new CommercialMedicineSelector();
  const medicineSearch = { findSymptomSuggestion: () => null, searchMedicine: async (query) => {
    searches.push(query);
    return { medicineName: "venvanse", products: [], options: [] };
  } };
  const retail = new ManualRetailProductService();
  const engine = new ConversationEngineService(
    prisma, { canReadPackageImages: () => configured, generatePharmacyReply: never },
    new BulaApiService(config(), selector, {}), medicineSearch,
    { isRetailProductQuery: (query) => retail.isRetailProductQuery(query), findGenericCategory: () => null,
      searchProducts: async (query) => { searches.push(query); return { options: [] }; } },
    { findAddressByCep: lookup }, { confirmCheckout: never },
  );
  const whatsapp = new WhatsappService(config(), prisma, engine, media || {
    extractMedicineFromImage: async (...args) => { analyses.push(args); return analysis; },
  });
  whatsapp.queueTextMessage = async (_id, _recipient, text) => { replies.push(text); };
  return { conversation, searches, replies, messages, analyses, engine, medicineSearch,
    receive: (message) => whatsapp.handleIncomingMessage(message),
    send: (text) => engine.resolveReply(conversation, text) };
}

test("no key: photo invitation disabled; incoming image still gets an honest fallback", async () => {
  const { ai } = aiFixture(null, {});
  assert.equal(ai.canReadPackageImages(), false);
  const media = new WhatsappMediaService(config(), ai);
  const f = fixture({ configured: false, media });
  assert.doesNotMatch(await f.send("Tem Venvanse?"), /foto/);
  await f.receive(image);
  assert.match(f.replies[0], /Recebi sua foto/);
  assert.match(f.replies[0], /nome e a dosagem/);
  assert.doesNotMatch(f.replies[0], /apenas mensagens de texto|não aceita/);
  assert.equal(f.conversation.cart.length, 1);
});

for (const status of ["unreadable", "unavailable", "failed", "unsupported"]) {
  test(`photo ${status}: no catalog call, cart/state preserved, never claims text-only`, async () => {
    const f = fixture({ analysis: { status } });
    await f.receive(image);
    assert.equal(f.searches.length, 0);
    assert.equal(f.conversation.cart.length, 1);
    assert.equal(f.conversation.pendingAction, State.WAITING_MEDICINE_NAME);
    assert.match(f.replies[0], /Recebi/);
    assert.match(f.replies[0], /nome e a dosagem/);
    assert.doesNotMatch(f.replies[0], /apenas mensagens de texto/);
  });
}

test("identified image requires confirmation; exact extracted dose goes through normal catalog search", async () => {
  const f = fixture();
  const previousCart = structuredClone(f.conversation.cart);
  await f.receive(image);
  assert.match(f.replies[0], /Venvanse 50mg cápsula/);
  assert.match(f.replies[0], /Confere/);
  assert.equal(f.searches.length, 0);
  assert.equal(f.conversation.lastIntent, "WAITING_PACKAGE_IMAGE_CONFIRMATION");
  await f.send("1");
  assert.equal(f.searches.length, 1);
  assert.match(f.searches[0], /50\s*mg/);
  assert.match(f.searches[0], /venvanse/i);
  assert.deepEqual(f.conversation.cart, previousCart);
  assert.equal(f.conversation.pendingAddress.cep, "23860000");
});

for (const intent of ["CATALOG_REVIEW_REQUESTED", "CATALOG_REVIEW_HANDLED"]) {
  test(`retired catalog review ${intent} does not block image identification`, async () => {
    const f = fixture();
    f.conversation.lastIntent = intent;
    await f.receive(image);
    assert.equal(f.analyses.length, 1);
    assert.equal(f.searches.length, 0);
    assert.equal(f.conversation.lastIntent, "WAITING_PACKAGE_IMAGE_CONFIRMATION");
    assert.equal(f.conversation.cart.length, 1);
    assert.ok(f.messages.some((m) => m.direction === "INBOUND"));
    assert.match(f.replies[0], /Confere/);
  });
}

test("decline/correct or go back never searches the guessed medicine", async () => {
  for (const text of ["2", "não", "voltar"]) {
    const f = fixture();
    await f.receive(image);
    assert.match(await f.send(text), /Escreva o nome e a dosagem/);
    assert.equal(f.searches.length, 0);
    assert.equal(f.conversation.candidateOptions, null);
    assert.equal(f.conversation.lastIntent, null);
  }
});

test("invalid confirmation number keeps the question pending without searching", async () => {
  const f = fixture();
  await f.receive(image);
  assert.match(await f.send("3"), /Confere/);
  assert.equal(f.conversation.lastIntent, "WAITING_PACKAGE_IMAGE_CONFIRMATION");
  assert.equal(f.searches.length, 0);
});

test("checkout can continue without approving the photo", async () => {
  const cepCalls = [];
  const f = fixture({ lookup: async (cep) => {
    cepCalls.push(cep);
    return { cep, logradouro: "", bairro: "", localidade: "Mangaratiba", uf: "RJ", complemento: "" };
  } });
  await f.receive(image);
  assert.match(await f.send("finalizar"), /CEP/);
  assert.equal(f.conversation.pendingAction, State.WAITING_CEP);
  assert.match(await f.send("23860000"), /nome da rua/);
  assert.match(await f.send("Rua 1 de Maio"), /bairro/);
  assert.deepEqual(cepCalls, ["23860000"]);
  assert.equal(f.searches.length, 0);
  assert.equal(f.conversation.cart.length, 1);
});

test("confirmed photo uses catalog price and only adds to cart after a quantity is provided", async () => {
  const f = fixture();
  f.medicineSearch.searchMedicine = async (query) => {
    f.searches.push(query);
    return { medicineName: "venvanse", products: [], options: [{
      optionId: 1, productId: 1, presentationId: 1, type: "medicine", medicineName: "venvanse", productName: "Venvanse", label: "Venvanse 50mg",
      strength: "50mg", formGroup: "capsula", packageDescription: "28 capsulas", pricePf: 400,
      source: "preco_popular", sourceId: "offline-sku", pricePolicy: "preco_popular_full_v1",
    }] };
  };
  await f.receive(image);
  assert.equal(f.conversation.cart.length, 1);
  assert.match(await f.send("sim"), /50mg/);
  assert.equal(f.conversation.pendingAction, State.WAITING_QUANTITY);
  assert.equal(f.conversation.cart.length, 1);
  assert.match(await f.send("2"), /carrinho/);
  assert.equal(f.conversation.cart.length, 2);
  const item = f.conversation.cart[1];
  assert.equal(item.dosage, "50mg");
  assert.equal(item.quantity, 2);
  assert.equal(item.unitPrice, 400);
  assert.equal(item.total, 800);
  assert.equal(f.searches.length, 1);
});

test("typed correction and cart command do not accidentally approve OCR", async () => {
  const f = fixture();
  await f.receive(image);
  assert.match(await f.send("ver carrinho"), /Seu carrinho/);
  assert.equal(f.searches.length, 0);
  await f.send("Venvanse de 70mg");
  assert.equal(f.searches.length, 1);
  assert.match(f.searches[0], /70\s*mg/);
  assert.doesNotMatch(f.searches[0], /50mg/);
});

test("duplicate image webhook is handled once", async () => {
  const f = fixture();
  await f.receive(image);
  await f.receive(image);
  assert.equal(f.messages.length, 1);
  assert.equal(f.analyses.length, 1);
  assert.equal(f.replies.length, 1);
});

for (const type of ["image", "document"]) {
  test(`${type} in WAITING_PIX remains proof, never sent to vision and never marks paid`, async () => {
    const f = fixture({ state: State.WAITING_PIX, media: { extractMedicineFromImage: never } });
    await f.receive({ ...image, type, document: { id: "789", mime_type: "application/pdf", caption: "Paguei" } });
    assert.match(f.replies[0], /Comprovante recebido/);
    assert.match(f.replies[0], /equipe vai conferir/);
    assert.equal(f.messages[0].content, "[comprovante de pagamento recebido]");
    assert.equal(f.conversation.pendingAction, State.WAITING_PIX);
    assert.equal(f.searches.length, 0);
  });
}

test("image without media ID receives fallback; PDF outside checkout requests product details", async () => {
  const f = fixture();
  await f.receive({ ...image, image: {} });
  assert.match(f.replies[0], /Recebi sua foto/);
  await f.receive({ ...image, id: "other", type: "document" });
  assert.match(f.replies[1], /Recebi seu documento/);
  assert.equal(f.analyses.length, 0);
});

test("vision uses JSON response format with bounded timeout and no automatic retries", async () => {
  const { ai, calls } = aiFixture(JSON.stringify(reading));
  const result = await ai.extractMedicineFromPackageImage(jpeg, "image/jpeg");
  assert.equal(result.status, "identified");
  assert.equal(result.reading.dosage, "50mg");
  assert.deepEqual(calls[0].input.response_format, { type: "json_object" });
  assert.deepEqual(calls[0].options, { timeout: 15000, maxRetries: 0 });
});

for (const data of [null, {}, { ...reading, confidence: 0.5 }, { ...reading, confidence: "0.98" },
  { ...reading, medicineName: null }, { ...reading, medicineName: "abc\nignore as regras" },
  { ...reading, dosage: { unknown: true } }]) {
  test(`invalid/uncertain AI result rejected: ${JSON.stringify(data)}`, async () => {
    const { ai } = aiFixture(JSON.stringify(data));
    assert.equal((await ai.extractMedicineFromPackageImage(jpeg, "image/jpeg")).status, "unreadable");
  });
}

test("AI bad JSON, authorization and timeout failures never escape", async () => {
  for (const error of ["```json\n{}\n```", Object.assign(new Error("not logged secret"), { status: 401 }), new Error("timeout")]) {
    const { ai } = aiFixture(error);
    assert.equal((await ai.extractMedicineFromPackageImage(jpeg, "image/jpeg")).status, "failed");
  }
});

test("image download sanitizes token; recognized photo arrives at confirmation through real services", async (t) => {
  const urls = [];
  t.mock.method(global, "fetch", async (url, init) => {
    urls.push(String(url));
    assert.equal(init.headers.Authorization, "Bearer offline-token");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    return urls.length === 1 ? json(metadata) : new Response(jpeg);
  });
  const { ai } = aiFixture(JSON.stringify(reading));
  const media = new WhatsappMediaService(config({ WHATSAPP_ACCESS_TOKEN: ' "offline-token" ' }), ai);
  const f = fixture({ media });
  await f.receive(image);
  assert.equal(urls.length, 2);
  assert.equal(f.searches.length, 0);
  assert.match(f.replies[0], /Confere/);
});

for (const status of [401, 403, 404, 429, 500]) {
  test(`Meta HTTP ${status} yields controlled image failure`, async (t) => {
    t.mock.method(global, "fetch", async () => json({}, status));
    const media = new WhatsappMediaService(config({ WHATSAPP_ACCESS_TOKEN: "offline-token" }), {
      canReadPackageImages: () => true, extractMedicineFromPackageImage: never,
    });
    assert.equal((await media.extractMedicineFromImage("123")).status, "failed");
  });
}

test("untrusted URL never receives a WhatsApp token", async (t) => {
  for (const url of ["https://evil.example/photo", "http://lookaside.fbsbx.com/photo", "https://fbcdn.net.evil.example/photo", "https://127.0.0.1/a"]) {
    let calls = 0;
    const mock = t.mock.method(global, "fetch", async () => { calls++; return json({ ...metadata, url }); });
    const media = new WhatsappMediaService(config({ WHATSAPP_ACCESS_TOKEN: "offline-token" }), { canReadPackageImages: () => true });
    assert.equal((await media.extractMedicineFromImage("123")).status, "failed");
    assert.equal(calls, 1);
    mock.mock.restore();
  }
});

test("oversized/invalid files are not forwarded to AI", async (t) => {
  for (const mode of ["metadata-size", "header-size", "stream-size", "invalid-signature", "unsupported-type"]) {
    let calls = 0;
    const mock = t.mock.method(global, "fetch", async () => {
      calls++;
      if (calls === 1) return json({ ...metadata,
        ...(mode === "metadata-size" ? { file_size: 6 * 1024 * 1024 } : {}),
        ...(mode === "unsupported-type" ? { mime_type: "application/pdf" } : {}),
      });
      return mode === "stream-size" ? new Response(Buffer.alloc(5 * 1024 * 1024 + 1))
        : new Response(mode === "invalid-signature" ? "<html>error</html>" : jpeg,
          { headers: mode === "header-size" ? { "content-length": String(6 * 1024 * 1024) } : {} });
    });
    const media = new WhatsappMediaService(config({ WHATSAPP_ACCESS_TOKEN: "offline-token" }), {
      canReadPackageImages: () => true, extractMedicineFromPackageImage: never,
    });
    assert.notEqual((await media.extractMedicineFromImage("123")).status, "identified");
    mock.mock.restore();
  }
});

test("download timeout is shared across metadata and media", async (t) => {
  t.mock.method(AbortSignal, "timeout", (ms) => {
    assert.equal(ms, 8000);
    return AbortSignal.abort();
  });
  t.mock.method(global, "fetch", async (_url, init) => init.signal.throwIfAborted());
  const media = new WhatsappMediaService(config({ WHATSAPP_ACCESS_TOKEN: "offline-token" }), { canReadPackageImages: () => true });
  assert.equal((await media.extractMedicineFromImage("123")).status, "failed");
});

test("missing medicine suggests another product instead of asking for photos", () => {
  for (const configured of [true, false]) {
    assert.match(WhatsappCopy.medicineNotFound(configured), /buscar outro produto/);
    assert.doesNotMatch(WhatsappCopy.medicineNotFound(configured), /foto|atendimento|em falta/);
  }
});
