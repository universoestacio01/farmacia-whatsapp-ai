const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { chromium } = require("playwright");
const { createAdminPreview } = require("./preview-admin");

async function run() {
  const demo = createAdminPreview();
  const server = http.createServer(demo.app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  const output = path.join(os.tmpdir(), "raia-admin-qa");
  await fs.mkdir(output, { recursive: true });
  const failures = [];
  let assertions = 0;
  function check(condition, message) {
    assert.ok(condition, message);
    assertions += 1;
  }
  try {
    browser = await chromium.launch({
      headless: true,
      channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    page.on("pageerror", (error) => failures.push(error.message));
    await page.route("**/*", (route) => {
      if (!route.request().url().startsWith(origin)) {
        failures.push(
          `Unexpected external request: ${new URL(route.request().url()).hostname}`,
        );
        return route.abort();
      }
      return route.continue();
    });
    await page.goto(`${origin}/admin/`);
    await page.waitForSelector("#metrics-grid button");
    check(
      (await page.locator("#metrics-grid button").count()) === 8,
      "All overview metrics are actionable",
    );
    await page
      .locator('#metrics-grid button[data-metric-section="payments"]')
      .click();
    await page.waitForSelector("#pending-payments-list .payment-row");
    await page.selectOption("#proof-filter", "received");
    check(
      (await page.locator("#pending-payments-list .payment-row").count()) === 1,
      "Proof filter works",
    );
    await page.fill("#payment-search", "joao");
    check(
      (await page.locator("#pending-payments-list .payment-row").count()) === 1,
      "Search ignores accents",
    );
    await page.selectOption("#waiting-filter", "60");
    check(
      (await page.locator("#pending-payments-list .payment-row").count()) === 0,
      "Wait-time filter works",
    );
    await page.selectOption("#waiting-filter", "");
    await page.click("#pending-payments-list [data-confirm-payment-id]");
    await page.click('#confirm-payment-dialog button[value="cancel"]');
    check(
      !Object.keys(demo.counts).some((key) => key.includes("confirm-payment")),
      "Opening/cancelling dialog never confirms payment",
    );

    await page.click('[data-section="conversations"]');
    await page.waitForSelector('[data-conversation-id="chat1"]');
    await page.route("**/conversations/chat1/messages?*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await route.continue().catch(() => {});
    });
    await page.click('[data-conversation-id="chat1"]');
    await page.click('[data-conversation-id="chat2"]');
    await page.waitForFunction(() =>
      document.querySelector("#message-thread").textContent.includes("João"),
    );
    await page.waitForTimeout(400);
    check(
      !(await page.textContent("#message-thread")).includes("Marina"),
      "Late chat response cannot overwrite another customer",
    );
    await page.unroute("**/conversations/chat1/messages?*");
    await page.fill("#manual-message-text", "Resposta ainda não enviada");
    await page.click('[data-conversation-id="chat1"]');
    await page.waitForFunction(() =>
      document.querySelector("#message-thread").textContent.includes("Marina"),
    );
    check(
      (await page.inputValue("#manual-message-text")) === "",
      "Drafts do not leak across customers",
    );
    await page.click('[data-conversation-id="chat2"]');
    await page.waitForFunction(() =>
      document.querySelector("#message-thread").textContent.includes("João"),
    );
    check(
      (await page.inputValue("#manual-message-text")) ===
        "Resposta ainda não enviada",
      "Draft restored when returning to customer",
    );
    demo.messages.chat2.push({
      id: "new",
      direction: "INBOUND",
      content: "Nova mensagem durante o atendimento",
      status: "RECEIVED",
      createdAt: new Date().toISOString(),
    });
    await page.click("#refresh-button");
    await page.waitForFunction(() =>
      document
        .querySelector("#message-thread")
        .textContent.includes("Nova mensagem"),
    );
    check(
      (await page.inputValue("#manual-message-text")) ===
        "Resposta ainda não enviada",
      "Refresh updates messages without losing draft",
    );
    await page.route("**/conversations/chat2/messages", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "Falha simulada no envio" }),
      }),
    );
    await page.click("#send-message-button");
    await page.waitForFunction(() =>
      document.querySelector("#toast").textContent.includes("Falha simulada"),
    );
    check(
      (await page.inputValue("#manual-message-text")) ===
        "Resposta ainda não enviada",
      "Failure preserves draft for operator review",
    );
    await page.unroute("**/conversations/chat2/messages");
    await page.route("**/conversations/chat2/messages", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await route.continue();
    });
    await page.evaluate(() => {
      const form = document.getElementById("manual-message-form");
      form.requestSubmit();
      form.requestSubmit();
    });
    await page.waitForFunction(
      () => !document.querySelector("#send-message-button").disabled,
    );
    check(
      demo.counts["POST /conversations/chat2/messages"] === 1,
      "Double submit sends only once",
    );
    await page.unroute("**/conversations/chat2/messages");
    await page.click("#reset-conversation-button");
    await page.waitForSelector("#action-dialog[open]");
    await page.click('#action-dialog button[value="cancel"]');
    check(
      !demo.counts["POST /conversations/chat2/reset"],
      "Reset requires explicit confirmation",
    );
    await page.screenshot({
      path: path.join(output, "conversations-desktop.png"),
      fullPage: true,
    });

    await page.click('[data-section="medicine-priorities"]');
    await page.waitForFunction(() =>
      document
        .querySelector("#medicine-priorities-editor")
        .value.includes("dipirona"),
    );
    const validRules = await page.inputValue("#medicine-priorities-editor");
    await page.fill(
      "#medicine-priorities-editor",
      "rascunho inválido ainda não salvo",
    );
    await page.click("#refresh-button");
    await page.click('[data-section="orders"]');
    await page.click('[data-section="medicine-priorities"]');
    check(
      (await page.inputValue("#medicine-priorities-editor")) ===
        "rascunho inválido ainda não salvo",
      "Refresh and navigation preserve dirty priorities",
    );
    await page.click("#save-medicine-priorities-button");
    check(
      !demo.counts["PUT /medicine-priorities"],
      "Invalid JSON never reaches backend",
    );
    await page.fill("#medicine-priorities-editor", validRules);
    await page.click("#save-medicine-priorities-button");
    await page.waitForFunction(
      () =>
        document.querySelector("#priority-save-state").textContent ===
        "Sem alterações pendentes",
    );
    check(
      demo.counts["PUT /medicine-priorities"] === 1,
      "Priorities saved once",
    );

    await page.click('[data-section="orders"]');
    await page.waitForSelector('[data-order-id="order-demo-1"]');
    await page.click(
      '[data-order-id="order-demo-1"] [data-table-confirm-payment-id]',
    );
    await page.evaluate(() => {
      const button = document.querySelector("#confirm-payment-submit");
      button.click();
      button.click();
    });
    await page.waitForFunction(
      () => !document.querySelector("#confirm-payment-dialog").open,
    );
    check(
      demo.counts["POST /orders/order-demo-1/confirm-payment"] === 1,
      "Payment button does not duplicate confirmation requests",
    );
    await page.click('[data-order-id="order-demo-1"]');
    await page.waitForSelector("#order-open-conversation");
    check(
      (await page.textContent("#order-detail")).includes(
        "Sala de demonstração",
      ),
      "Delivery complement is visible",
    );
    await page.selectOption("#order-status-select", "DELIVERED");
    await page.waitForSelector("#action-dialog[open]");
    await page.click('#action-dialog button[value="cancel"]');
    await page.waitForFunction(
      () => !document.querySelector("#order-status-select").disabled,
    );
    check(
      (await page.inputValue("#order-status-select")) === "PAID",
      "Cancelled status change restores actual value",
    );

    await page.click('[data-section="providers"]');
    await page.waitForSelector(".request-log");
    const providerCards = await page.textContent("#providers-grid");
    check(providerCards.includes("Preço integral do catálogo"), "Panel shows full catalog price policy");
    check(!/PharmaDB|BulAPI|Cosmos|Desconto/.test(providerCards), "Retired providers are not advertised as active integrations");
    await page.selectOption("#provider-log-outcome", "errors");
    check(
      (await page.locator(".request-log").count()) === 1,
      "API failures are filterable",
    );
    await page.click(".request-log summary");
    check(
      (await page.textContent(".log-details")).includes("429"),
      "Expanded API diagnostics expose HTTP status",
    );
    await page.selectOption("#provider-log-outcome", "");

    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const section of [
        "overview",
        "payments",
        "conversations",
        "orders",
        "medicine-priorities",
        "providers",
        "errors",
      ]) {
        await page.click(`[data-section="${section}"]`);
        await page.waitForFunction(
          () => !document.querySelector("#refresh-button").disabled,
        );
        check(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth + 1,
          ),
          `No horizontal overflow: ${section} at ${width}px`,
        );
        check(
          await page.locator("#logout-button").isVisible(),
          `Logout remains accessible at ${width}px`,
        );
        if (["overview", "providers", "payments"].includes(section))
          await page.screenshot({
            path: path.join(output, `${section}-${width}.png`),
            fullPage: true,
          });
      }
    }
    await page.uncheck("#auto-refresh");
    check(
      await page.evaluate(() => state.refreshTimer === null),
      "Auto refresh can be paused",
    );
    await page.route("**/admin/api/errors?*", (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/json",
        body: '{"message":"expired"}',
      }),
    );
    await page.click("#refresh-button");
    await page.waitForSelector("#auth-modal:not(.hidden)");
    check(
      (await page.locator("#orders-table .table-row").count()) === 0,
      "Expired session clears private data",
    );
    check(
      (await page.inputValue("#manual-message-text")) === "",
      "Expired session clears drafts",
    );
    check(
      await page.evaluate(() => document.querySelector(".app-shell").inert),
      "Expired session prevents background interaction",
    );
    check(
      failures.length === 0,
      `No browser errors or external requests: ${failures.join("; ")}`,
    );
    console.log(
      `Admin browser QA passed: ${assertions} checks. Screenshots: ${output}`,
    );
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
