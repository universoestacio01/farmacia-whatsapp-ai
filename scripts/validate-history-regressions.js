const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Logger } = require('@nestjs/common');
const { Prisma, ConversationState: State } = require('@prisma/client');
const { CommercialMedicineSelector } = require('../dist/integrations/commercial-medicine-selector');
const { PrecoPopularService } = require('../dist/integrations/preco-popular.service');
const { MedicineSearchOrchestratorService } = require('../dist/integrations/medicine-search-orchestrator.service');
const { BulaApiService } = require('../dist/integrations/bula-api.service');
const { ProductSearchOrchestratorService } = require('../dist/integrations/product-search-orchestrator.service');
const { ManualRetailProductService } = require('../dist/integrations/manual-retail-product.service');
const { ConversationEngineService } = require('../dist/whatsapp/conversation-engine.service');
const { ConversationInputService } = require('../dist/whatsapp/conversation-input.service');
const { matchesRetailQuery } = require('../dist/utils/retail-search-query.util');
const { hasMultipleProductRequests, namedQueryBeforeSymptom } = require('../dist/utils/customer-query.util');
const { providerFailure } = require('../dist/utils/provider-failure.util');
const { SYMPTOM_MEDICINE_RULES } = require('../dist/config/symptom-medicine.config');

Logger.overrideLogger(false);
const never = async () => assert.fail('Unexpected external side effect');
global.fetch = never;
const config = { get: () => undefined };
function row(id, name, medicine = true) {
  return { productId: id, productName: name, categories: [medicine ? '/Medicamentos/' : '/Higiene/'],
    items: [{ itemId: id, name, sellers: [{ commertialOffer: { Price: 10, IsAvailable: true, AvailableQuantity: 10 } }] }] };
}
// Synthetic fixtures exercise logic; no real customer/order data or invented live offers.
const catalog = {
  dipirona: [row('1', 'Dipirona 500mg com 10 comprimidos')],
  maxidex: [row('2', 'Maxidex Suspensao Oftalmica 1mg/ml 5ml')],
  metronidazol: [row('3', 'Metronidazol Pomada 100mg/g 50g')],
  forxiga: [row('90', 'Forxiga 10mg Com 30 Comprimidos')],
  itraconazol: [row('91', 'Itraconazol 100mg Com 15 Capsulas Duras')],
  mounjaro: [row('92', 'Mounjaro 5mg/0,5ml Com 4 Canetas De 0,5ml Solucao Injetavel'), row('93', 'Mounjaro 2,5mg/0,5ml Com 4 Canetas De 0,5ml Solucao Injetavel')],
  tadalafila: [row('4', 'Tadalafila 20mg com 4 comprimidos')],
  'elixir paregorico': [row('5', 'Paregorico Catarinense Elixir 30ml')],
  'absorvente sempre livre com16 unidade': [row('6', 'Absorvente Sempre Livre com 16 Unidades', false)],
  'absorvente sempre livre com 16 unidade': [row('6', 'Absorvente Sempre Livre com 16 Unidades', false)],
  'absorvente sempre livre': [row('6', 'Absorvente Sempre Livre com 16 Unidades', false)],
  'fralda xg infantil': [row('7', 'Fralda Infantil XG 20 Unidades', false), row('8', 'Fralda Adulto XG 20 Unidades', false)],
};
function harness(t, backups = false) {
  const calls = [], events = [], searches = [];
  t.mock.method(global, 'fetch', async input => {
    const url = new URL(input); assert.equal(url.origin, 'https://www.precopopular.com.br');
    const term = url.searchParams.get('ft'); calls.push(term);
    return new Response(JSON.stringify(catalog[term] || []), { status: 200 });
  });
  const selector = new CommercialMedicineSelector();
  const provider = new PrecoPopularService(config, selector);
  const rules = { getRulesForPrinciple: async () => [] };
  const popular = { findSymptomSuggestion: text => SYMPTOM_MEDICINE_RULES.find(r => r.patterns.some(p => text.toLowerCase().includes(p))) || null };
  const backup = name => ({ name, isEnabled: () => true, searchWithStatus: async () => ({ status: 'unavailable', options: [], failureReason: 'authentication_failed', statusCode: 401 }) });
  const medicine = new MedicineSearchOrchestratorService(selector, popular, rules, provider,
    backups ? backup('openai_web') : undefined, { record: async event => events.push(event) });
  const originalSearch = medicine.searchMedicine.bind(medicine);
  medicine.searchMedicine = query => { searches.push(query); return originalSearch(query); };
  const retail = new ProductSearchOrchestratorService(new ManualRetailProductService(), provider);
  const conversation = { id: 'test', customerId: 'test', pendingAction: State.WAITING_MEDICINE_NAME, lastIntent: null,
    lastMedicine: null, currentMedicineQuery: null, currentRetailCategory: null, selectedPresentation: null, candidateOptions: [], cart: [], pendingAddress: null };
  const prisma = { conversation: { update: async ({ data }) => {
    for (const [key, value] of Object.entries(data)) conversation[key] = value === Prisma.JsonNull ? null : value;
    return conversation;
  } } };
  const engine = new ConversationEngineService(prisma, { generatePharmacyReply: never, canReadPackageImages: () => false },
    new BulaApiService(config, selector, rules), medicine, retail, {}, { confirmCheckout: never }, new ConversationInputService(), provider);
  return { conversation, calls, events, searches, selector, medicine, engine, send: text => engine.resolveReply(conversation, text) };
}

for (const [text, expected] of [['Uma embalagem com 12 unidades', 1], ['2 caixas com 30 comprimidos', 2], ['uma', 1], ['duas', 2], ['2 desse', 2], ['3', 3], ['1 caixa de 10 capsulas', 1]]) {
  test(`commercial quantity: ${text}`, () => assert.equal(new ConversationInputService().parseQuantity(text), expected));
}
for (const text of ['1 ou 2', '12mg', '0,5', '-2', '1 caixa 2 frascos', '2 de 50mg', '100', '0', '12345678']) {
  test(`ambiguous or invalid quantity rejected: ${text}`, () => assert.equal(new ConversationInputService().parseQuantity(text), null));
}
test('one package creates exactly one cart item unit, never its internal tablet count', async t => {
  const f = harness(t); await f.send('Dipirona');
  await f.send('Uma embalagem com 10 unidades');
  assert.equal(f.conversation.cart[0].quantity, 1); assert.equal(f.conversation.cart[0].total, 10);
  assert.equal(f.calls.length, 1);
});
test('a different requested pack size cannot silently enter the cart', async t => {
  const f = harness(t); await f.send('Dipirona');
  assert.match(await f.send('Uma embalagem com 12 unidades'), /conferir/);
  assert.equal(f.conversation.cart.length, 0);
});
for (const query of ['Entrega?', 'Vocês fazem entrega a partir de qual valor do pedido', 'Vc tem esse remédio?', 'Sério', 'Oie', 'Quero modificar meu pedido', '2 desse', 'Qual opção 👆', 'Colírio', 'Quero pomada']) {
  test(`non-product input does not call catalogs: ${query}`, async t => {
    const f = harness(t); const reply = await f.send(query);
    assert.equal(f.calls.length, 0); assert.equal(f.searches.length, 0);
    assert.doesNotMatch(reply, /Não localizei|Não consegui concluir/);
  });
}
for (const query of ['1 Buscopan com\n1 Desloratadina', 'Cefalexina 500mg\nRifocina spray', 'um neosoro e uma caixa de glifage de 500']) {
  test(`multiple items preserve cart and request individual confirmation: ${query}`, async t => {
    const f = harness(t); f.conversation.cart = [{ name: 'previous', quantity: 1 }];
    assert.match(await f.send(query), /um por vez/); assert.equal(f.calls.length, 0);
    assert.equal(f.conversation.cart[0].name, 'previous');
  });
}
for (const query of ['Amoxicilina com clavulanato\n875 mg', 'Kit shampoo e condicionador', 'clonazepam 2,5 mg/ml', 'dor e febre', 'Estou com dor de barriga e enjoo']) {
  test(`do not split a combination, kit or dosage: ${query}`, () => assert.equal(hasMultipleProductRequests(query), false));
}
for (const [query, term] of [['Metronidazol (pomada)', 'metronidazol'], ['Colírio maxidex', 'maxidex'], ['Olina grande', 'olina'], ['Ozivy 1mg solução injetavel', 'ozivy']]) {
  test(`name-only query with separate attributes: ${query}`, async t => {
    const f = harness(t); await f.medicine.searchMedicine(query); assert.equal(f.calls[0], term);
  });
}
test('Maxidex is not discarded for containing the word colirio in the request', async t => {
  const f = harness(t); const result = await f.medicine.searchMedicine('Colirio maxidex');
  assert.equal(result.options.length, 1); assert.equal(result.options[0].formGroup, 'oftalmico');
});
for (const [query, term] of [['uma pergunta forxiga', 'forxiga'], ['comprar itraconazol 100 mg capsula dura', 'itraconazol']]) {
  test(`production history phrase keeps only the product name: ${query}`, async t => {
    const f = harness(t);
    const reply = await f.send(query);
    assert.equal(f.calls[0], term);
    assert.ok(f.conversation.selectedPresentation || f.conversation.candidateOptions?.length, reply);
    assert.doesNotMatch(reply, /n[aã]o est[aá] dispon[ií]vel/i);
  });
}

test('contextual Mounjaro 5mg matches only the labeled 5mg per 0.5ml pen and reaches cart', async t => {
  const f = harness(t);
  await f.send('Tem Mounjaro?');
  assert.equal(f.conversation.candidateOptions.length, 2);
  const reply = await f.send('Tem de 5mg?');
  assert.ok(f.conversation.selectedPresentation, reply);
  assert.equal(f.conversation.selectedPresentation.strength, '5mg/0,5ml');
  await f.send('1');
  assert.equal(f.conversation.cart.length, 1);
  assert.equal(f.conversation.cart[0].dosage, '5mg/0,5ml');
  assert.equal(f.conversation.cart[0].unitPrice, 10);
  assert.equal(f.calls.length, 1);
});

test('pen-dose matching never reinterprets ordinary liquids, multidose bottles or concentrations', () => {
  const { medicinePresentationStrengthMatches: matches } = require('../dist/utils/medicine-strength.util');
  for (const name of ['Mounjaro Solucao Injetavel 2ml', 'Teste Suspensao Oral 4 Canetas de 0,5ml', 'Teste Solucao Injetavel Caneta Multidose 0,5ml', 'Teste Solucao Injetavel 4 Canetas De 3ml']) {
    assert.equal(matches('5mg/0,5ml', '5mg', name), false, name);
  }
  const name = 'Mounjaro 5mg/0,5ml Com 4 Canetas De 0,5ml Solucao Injetavel';
  assert.equal(matches('5mg/0,5ml', '5mg', name), true);
  for (const requested of ['2,5mg', '10mg', '5mg/ml', '5mg+2mg']) assert.equal(matches('5mg/0,5ml', requested, name), false);
});

test('ophthalmic ointment is not relabelled as eye drops', () => {
  const s = new CommercialMedicineSelector();
  assert.equal(s.parseMedicineQuery('Maxidex pomada oftalmica').formGroup, 'pomada');
  assert.equal(s.extractPackageInfo('Maxidex pomada oftalmica 3g').formGroup, 'pomada');
});
test('ml never silently becomes mg or an unconstrained tablet search', async t => {
  const f = harness(t, true); const reply = await f.send('Tadalafila 20ml');
  assert.match(reply, /não essa dosagem ou apresentação/);
  assert.equal(f.conversation.selectedPresentation, null); assert.equal(f.conversation.cart.length, 0);
});
test('volume-specific cache cannot reuse a different volume', async t => {
  const f = harness(t); assert.equal((await f.medicine.searchMedicine('Elixir paregorico 30ml')).options.length, 1);
  assert.equal((await f.medicine.searchMedicine('Elixir paregorico 20ml')).options.length, 0);
});
for (const query of ['Absorvente sempre livre com16 unidades', 'Absorventes sempre livres']) {
  test(`retail spelling and spacing: ${query}`, async t => {
    assert.equal(matchesRetailQuery('Absorvente Sempre Livre com 16 Unidades', query, 'absorvente'), true);
    const f = harness(t); assert.match(await f.send(query), /Sempre Livre/); assert.ok(f.conversation.selectedPresentation);
  });
}
test('retail normalization still protects quantity and negative qualifiers', () => {
  assert.equal(matchesRetailQuery('Absorvente Sempre Livre com 8 Unidades', 'Absorvente sempre livre com16 unidades', 'absorvente'), false);
  assert.equal(matchesRetailQuery('Absorvente Sempre Livre com abas', 'Absorvente Sempre Livre sem abas', 'absorvente'), false);
});
test('ask diaper audience and never mix adult with infant products', async t => {
  const f = harness(t); assert.match(await f.send('Fralda XG'), /infantil ou para adulto/);
  assert.equal(f.calls.length, 0); await f.send('infantil');
  assert.ok(f.conversation.selectedPresentation); assert.doesNotMatch(f.conversation.selectedPresentation.label, /Adulto/);
});
test('named product precedes symptom suggestions', async t => {
  const f = harness(t); const allergy = SYMPTOM_MEDICINE_RULES.find(r => r.key === 'alergia');
  t.mock.method(f.medicine, 'findSymptomSuggestion', () => allergy);
  await f.send('Antialérgico Celestrat'); assert.deepEqual(f.searches, ['celestrat']);
  assert.ok(!f.calls.includes('loratadina')); assert.ok(!f.calls.includes('allegra'));
});
test('a symptom phrase with named lozenge retains that named product and form', () => {
  const rule = SYMPTOM_MEDICINE_RULES.find(r => r.patterns.includes('dor de garganta'));
  assert.equal(namedQueryBeforeSymptom('Alívio rápido dor de garganta pastilhas strepsils', rule), 'pastilhas strepsils');
  assert.equal(namedQueryBeforeSymptom('Preciso de um remedio para dor de garganta', rule), null);
});
test('duplicate generic brands do not repeat an identical known presentation', () => {
  const s = new CommercialMedicineSelector();
  const items = [1, 2, 3].map(id => ({ productName: `Tadalafila Marca${id}`, label: `Tadalafila Marca${id}`, medicineName: 'tadalafila',
    productId: id, presentationId: id, pricePf: 10 + id, formGroup: 'comprimido', strength: id === 3 ? '5mg' : '20mg', packageInfo: { unitCount: id === 3 ? 30 : 4 } }));
  const selected = s.rankCommercialOptions('Tadalafila', items).selected;
  assert.equal(selected.length, 2); assert.equal(selected.filter(o => o.strength === '20mg').length, 1);
});
test('backup error records preserve actionable failure without misreporting the primary', async t => {
  const f = harness(t, true); const reply = await f.send('produtoausente');
  assert.match(reply, /Não consegui consultar/);
  const event = f.events.find(e => e.operation === 'search_outcome');
  assert.match(event.failureReason, /authentication_failed/);
  assert.ok(f.events.some(e => e.operation === 'search_outcome' && /primary=not_found/.test(e.failureReason)));
});
test('OCR correction changes form without retaining the old tablet dose', async t => {
  const f = harness(t);
  f.conversation.lastIntent = 'WAITING_PACKAGE_IMAGE_CONFIRMATION';
  f.conversation.candidateOptions = { packageImageQuery: 'Clonazepam 2mg comprimido' };
  await f.send('Sim só que é em gotas que preciso');
  assert.equal(f.searches[0], 'clonazepam gotas');
  assert.doesNotMatch(f.searches[0], /2mg|comprimido/);
});
test('larger packaging preference survives normalization and comes first', () => {
  const s = new CommercialMedicineSelector();
  const options = [15, 60, 100].map(volume => ({ productName: `Olina ${volume}ml`, label: `Olina ${volume}ml`,
    medicineName: 'olina', presentationId: volume, formGroup: 'solucao oral', packageInfo: { volumeMl: volume }, pricePf: volume / 2 }));
  assert.equal(s.rankCommercialOptions('Olina grande', options).selected[0].packageInfo.volumeMl, 100);
  assert.equal(s.rankCommercialOptions('Olina pequena', options).selected[0].packageInfo.volumeMl, 15);
});
for (const [error, code] of [['PharmaDB auth HTTP 401', 'authentication_failed'], ['BulAPI HTTP 502', 'http_502'], ['PharmaDB respondeu 429', 'rate_limited'], ['request deadline exceeded', 'timeout_or_budget']]) {
  test(`safe provider failure classification: ${code}`, () => assert.equal(providerFailure(new Error(error)).failureReason, code));
}
