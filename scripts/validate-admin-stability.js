const assert = require("node:assert/strict");
const { test } = require("node:test");
const { AdminService } = require("../dist/admin/admin.service");
const { AdminController } = require("../dist/admin/admin.controller");
const {
  CommercialMedicineSelector,
} = require("../dist/integrations/commercial-medicine-selector");

global.fetch = async () => {
  throw new Error("Network forbidden in offline tests");
};

test("long conversations show the latest 100 messages in chronological order", async () => {
  const rows = Array.from({ length: 140 }, (_, i) => ({
    id: String(i).padStart(3, "0"),
    content: `Message ${i}`,
    createdAt: new Date(i * 1000),
  }));
  const client = {
    message: {
      findMany: async ({ where, orderBy, take }) => {
        assert.equal(where.conversationId, "conversation");
        assert.deepEqual(orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
        assert.equal(take, 100);
        return [...rows].reverse().slice(0, take);
      },
    },
  };
  const service = new AdminService({
    safePrismaCall: (_, callback) => callback(client),
  });
  const result = await service.conversationMessages("conversation", 1000);
  assert.equal(result.length, 100);
  assert.equal(result[0].content, "Message 40");
  assert.equal(result[99].content, "Message 139");
});

test("provider activity exposes only diagnostic metadata, never raw response or request URLs", async () => {
  let fields;
  const service = new AdminService({
    safePrismaCall: (_, callback) =>
      callback({
        providerRequestLog: {
          findMany: async ({ select }) => {
            fields = select;
            return [];
          },
        },
      }),
  });
  await service.providerRequestLogs();
  assert.equal(fields.rawPayload, undefined);
  assert.equal(fields.endpoint, undefined);
  assert.equal(fields.errorMessage, undefined);
  assert.equal(fields.traceId, true);
  assert.equal(fields.statusCode, true);
});

test("manual messages reject malformed, blank and oversized bodies before sending", () => {
  const calls = [];
  const controller = new AdminController(
    { sendManualMessage: (...args) => calls.push(args) },
    { get: () => "test-admin" },
  );
  for (const body of [null, undefined, {}, 1, "   ", "a".repeat(4001)]) {
    assert.throws(
      () => controller.sendManualMessage("test-admin", "chat", body),
      (error) => error.getStatus() === 400,
    );
  }
  controller.sendManualMessage("test-admin", "chat", " Olá! ");
  assert.deepEqual(calls, [["chat", "Olá!"]]);
  assert.throws(
    () => controller.sendManualMessage("wrong", "chat", "Olá"),
    (error) => error.getStatus() === 403,
  );
});

const selector = new CommercialMedicineSelector();
function option(strength, formGroup = "capsula") {
  return {
    productName: "Venvanse",
    label: `Venvanse ${strength}`,
    strength,
    formGroup,
    pricePf: 30,
    packageInfo: { unitCount: 28, formGroup },
    optionId: 1,
  };
}
test("requested 70mg cannot be replaced silently by 30mg in the shared selector", () => {
  assert.deepEqual(
    selector.selectCommercialOptions("Venvanse 70mg", [option("30mg")]),
    [],
  );
});
test("explicit pharmaceutical form cannot be replaced silently", () => {
  assert.deepEqual(
    selector.selectCommercialOptions("Venvanse gotas", [option("30mg")]),
    [],
  );
});

test("milligrams and milligrams per ml are not interchangeable", () => {
  assert.deepEqual(selector.selectCommercialOptions("Venvanse 50mg", [option("50mg/ml", "gotas")]), []);
  assert.deepEqual(selector.selectCommercialOptions("Venvanse 50mg/ml", [option("50mg")]), []);
});
test("exact requested dosage, equivalent 1g and broad dose diversity remain available", () => {
  assert.equal(
    selector.selectCommercialOptions("Venvanse 50mg", [
      option("30mg"),
      option("50mg"),
      option("70mg"),
    ])[0].strength,
    "50mg",
  );
  assert.equal(
    selector.selectCommercialOptions("Venvanse 1g", [option("1000mg")]).length,
    1,
  );
  assert.equal(
    new Set(
      selector
        .selectCommercialOptions("Venvanse", [
          option("30mg"),
          option("50mg"),
          option("70mg"),
        ])
        .map((item) => item.strength),
    ).size,
    3,
  );
});

test("duplicate presentation IDs cannot keep dosage selection in an infinite loop", () => {
  const results = selector.selectCommercialOptions("Venvanse", [
    { ...option("30mg"), presentationId: 1 },
    { ...option("50mg"), presentationId: 1 },
    { ...option("70mg"), presentationId: 2 },
  ]);
  assert.equal(results.length, 2);
  assert.deepEqual(
    results.map((item) => item.strength),
    ["30mg", "70mg"],
  );
});
