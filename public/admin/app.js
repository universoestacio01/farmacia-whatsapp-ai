const state = {
  section: "overview",
  token: localStorage.getItem("raia_admin_token") || "",
  conversations: [],
};

const pageTitleBySection = {
  overview: "Visão geral",
  conversations: "Conversas",
  orders: "Pedidos",
  providers: "APIs",
  errors: "Erros",
};

const currency = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

const dateTime = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

document.addEventListener("DOMContentLoaded", async () => {
  bindNavigation();
  bindAuth();
  bindActions();
  await bootstrap();
});

async function bootstrap() {
  const session = await api("/admin/api/session", { allowForbidden: true });

  if (session.protected && !session.authenticated) {
    showAuth();
    setAuthState("Acesso protegido");
    return;
  }

  hideAuth();
  setAuthState(session.protected ? "Acesso protegido" : "Acesso sem token");
  await refresh();
}

function bindNavigation() {
  document.querySelectorAll("[data-section]").forEach((button) => {
    button.addEventListener("click", () => setSection(button.dataset.section));
  });

  document.querySelectorAll("[data-section-target]").forEach((button) => {
    button.addEventListener("click", () => setSection(button.dataset.sectionTarget));
  });
}

function bindAuth() {
  document.getElementById("auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const token = document.getElementById("admin-token").value.trim();
    state.token = token;
    const session = await api("/admin/api/session", { allowForbidden: true });

    if (!session.authenticated) {
      state.token = "";
      document.getElementById("auth-error").textContent = "Token inválido.";
      return;
    }

    localStorage.setItem("raia_admin_token", token);
    hideAuth();
    setAuthState("Acesso protegido");
    await refresh();
  });
}

function bindActions() {
  document.getElementById("refresh-button").addEventListener("click", refresh);
  document.getElementById("database-check-button").addEventListener("click", checkDatabase);
  document.getElementById("logout-button").addEventListener("click", () => {
    localStorage.removeItem("raia_admin_token");
    state.token = "";
    showAuth();
    setAuthState("Sessão encerrada");
  });
}

function setSection(section) {
  state.section = section;
  document.querySelectorAll(".section").forEach((item) => {
    item.classList.toggle("active", item.id === section);
  });
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.section === section);
  });
  document.getElementById("page-title").textContent = pageTitleBySection[section] || "Painel";
  refresh();
}

async function refresh() {
  try {
    if (state.section === "overview") {
      await loadOverview();
    } else if (state.section === "conversations") {
      await loadConversations();
    } else if (state.section === "orders") {
      await loadOrders();
    } else if (state.section === "providers") {
      await loadProviders();
    } else if (state.section === "errors") {
      await loadErrors();
    }

    document.getElementById("last-updated").textContent = `Atualizado ${dateTime.format(new Date())}`;
  } catch (error) {
    showToast(error.message || "Falha ao atualizar painel.");
  }
}

async function loadOverview() {
  const data = await api("/admin/api/overview");
  renderMetrics(data.cards);
  renderConversationList(document.getElementById("latest-conversations"), data.latestConversations, false);
  renderOrders(document.getElementById("latest-orders"), data.latestOrders, "list");
}

async function loadConversations() {
  state.conversations = await api("/admin/api/conversations?limit=30");
  renderConversationList(document.getElementById("conversation-list"), state.conversations, true);
}

async function loadOrders() {
  const orders = await api("/admin/api/orders?limit=40");
  renderOrders(document.getElementById("orders-table"), orders, "table");
}

async function loadProviders() {
  const providers = await api("/admin/api/providers");
  renderProviders(providers);
}

async function loadErrors() {
  const data = await api("/admin/api/errors?limit=30");
  renderErrorSummary(data.summary);
  renderFailedMessages(data.failedMessages);
  renderFailedPayments(data.failedPayments);
}

async function checkDatabase() {
  const result = await api("/admin/api/database");
  const target = document.getElementById("database-result");
  target.innerHTML = `
    <div class="list-item">
      <div class="item-title">
        <span>Banco de dados</span>
        ${statusBadge(result.connected ? "Conectado" : "Falha", result.connected ? "ok" : "error")}
      </div>
      <div class="item-meta">
        <span>Configurado: ${result.configured ? "sim" : "não"}</span>
        ${result.error ? `<span>${escapeHtml(result.error)}</span>` : ""}
      </div>
    </div>
  `;
}

function renderMetrics(cards) {
  const items = [
    ["Conversas abertas", cards.openConversations],
    ["Em atendimento", cards.activeConversations],
    ["Mensagens 24h", cards.messages24h],
    ["Falhas 24h", cards.failedMessages24h],
    ["Pedidos 24h", cards.ordersToday],
    ["Pix pendentes", cards.pendingPayments],
    ["Pedidos pagos", cards.paidOrders],
    ["Receita paga", formatMoney(cards.paidRevenueCents)],
  ];

  document.getElementById("metrics-grid").innerHTML = items
    .map(([label, value]) => metricCard(label, value))
    .join("");
}

function renderConversationList(target, conversations, selectable) {
  if (!conversations.length) {
    target.innerHTML = empty("Nenhuma conversa encontrada.");
    return;
  }

  target.innerHTML = conversations
    .map((conversation) => `
      <div class="list-item" ${selectable ? `data-conversation-id="${conversation.id}"` : ""}>
        <div class="item-title">
          <span>${escapeHtml(conversation.customerName || conversation.whatsappNumber)}</span>
          ${statusBadge(conversation.pendingAction, conversation.pendingAction === "IDLE" ? "ok" : "warn")}
        </div>
        <p class="muted">${escapeHtml(conversation.lastMessage?.content || "Sem mensagens")}</p>
        <div class="item-meta">
          <span>${escapeHtml(conversation.whatsappNumber)}</span>
          <span>${dateTime.format(new Date(conversation.updatedAt))}</span>
          ${conversation.currentMedicineQuery ? `<span>${escapeHtml(conversation.currentMedicineQuery)}</span>` : ""}
          ${conversation.currentRetailCategory ? `<span>${escapeHtml(conversation.currentRetailCategory)}</span>` : ""}
        </div>
      </div>
    `)
    .join("");

  if (selectable) {
    target.querySelectorAll("[data-conversation-id]").forEach((item) => {
      item.addEventListener("click", () => selectConversation(item.dataset.conversationId));
    });
  }
}

async function selectConversation(id) {
  document.querySelectorAll("[data-conversation-id]").forEach((item) => {
    item.classList.toggle("active", item.dataset.conversationId === id);
  });

  const conversation = state.conversations.find((item) => item.id === id);
  document.getElementById("conversation-context").textContent = conversation
    ? `${conversation.whatsappNumber} · ${conversation.pendingAction}`
    : "Conversa selecionada";

  const messages = await api(`/admin/api/conversations/${id}/messages?limit=80`);
  const thread = document.getElementById("message-thread");

  if (!messages.length) {
    thread.className = "message-thread empty-state";
    thread.textContent = "Sem mensagens para exibir.";
    return;
  }

  thread.className = "message-thread";
  thread.innerHTML = messages
    .map((message) => `
      <div class="message ${message.direction === "OUTBOUND" ? "outbound" : "inbound"}">
        ${escapeHtml(message.content)}
        <small>${message.direction} · ${message.status} · ${dateTime.format(new Date(message.createdAt))}</small>
      </div>
    `)
    .join("");
  thread.scrollTop = thread.scrollHeight;
}

function renderOrders(target, orders, mode) {
  if (!orders.length) {
    target.innerHTML = empty("Nenhum pedido encontrado.");
    return;
  }

  if (mode === "table") {
    target.innerHTML = orders
      .map((order) => `
        <div class="table-row">
          <div>
            <strong>${escapeHtml(order.customer.whatsappNumber)}</strong>
            <div class="muted">${escapeHtml(order.customer.name || "Cliente WhatsApp")}</div>
          </div>
          <div>${statusBadge(order.status, orderStatusTone(order.status))}</div>
          <div>
            <strong>${formatMoney(order.totalCents)}</strong>
            <div class="muted">${escapeHtml(order.payment?.provider || "sem pagamento")}</div>
          </div>
          <div>
            ${statusBadge(order.payment?.status || "SEM_PIX", paymentStatusTone(order.payment?.status))}
            <div class="muted">${dateTime.format(new Date(order.createdAt))}</div>
          </div>
        </div>
      `)
      .join("");
    return;
  }

  target.innerHTML = orders
    .map((order) => `
      <div class="list-item">
        <div class="item-title">
          <span>${escapeHtml(order.customer.whatsappNumber)}</span>
          ${statusBadge(order.status, orderStatusTone(order.status))}
        </div>
        <div class="item-meta">
          <span>${formatMoney(order.totalCents)}</span>
          <span>${escapeHtml(order.payment?.status || "sem pagamento")}</span>
          <span>${dateTime.format(new Date(order.createdAt))}</span>
        </div>
      </div>
    `)
    .join("");
}

function renderProviders(data) {
  const providers = [
    ["Banco", data.database.configured, "Uso sob demanda", data.database.lazy],
    ["WhatsApp", data.whatsapp.configured, `API ${data.whatsapp.apiVersion}`, true],
    ["PharmaDB", data.medicines.pharmadbConfigured, `Principal: ${data.medicines.primaryProvider}`, true],
    ["BulAPI", data.medicines.bulapiConfigured, "Fallback de medicamentos", true],
    ["Cosmos", data.retailProducts.cosmosConfigured, `${data.retailProducts.cosmosTokenCount} token(s)`, true],
    ["SigiloPay", data.payments.sigilopayConfigured, data.payments.provider, true],
    ["Painel", data.admin.protected, data.admin.protected ? "Protegido" : "Sem ADMIN_TOKEN", true],
  ];

  document.getElementById("providers-grid").innerHTML = providers
    .map(([name, configured, detail, lazy]) => `
      <div class="provider-card">
        <div class="item-title">
          <h3>${name}</h3>
          ${statusBadge(configured ? "OK" : "Atenção", configured ? "ok" : "warn")}
        </div>
        <p class="muted">${escapeHtml(String(detail))}</p>
        <div class="item-meta"><span>${lazy ? "Não chamado no bootstrap" : ""}</span></div>
      </div>
    `)
    .join("");
}

function renderErrorSummary(summary) {
  const items = [
    ["Mensagens falhas", summary.failedMessages],
    ["Pagamentos falhos", summary.failedPayments],
    ["Pix pendentes", summary.pendingPayments],
    ["Pedidos cancelados", summary.cancelledOrders],
  ];
  document.getElementById("errors-summary").innerHTML = items
    .map(([label, value]) => metricCard(label, value))
    .join("");
}

function renderFailedMessages(messages) {
  const target = document.getElementById("failed-messages");
  target.innerHTML = messages.length
    ? messages.map((item) => `
      <div class="list-item">
        <div class="item-title">
          <span>${escapeHtml(item.customer)}</span>
          ${statusBadge("FAILED", "error")}
        </div>
        <p class="muted">${escapeHtml(item.content)}</p>
        <div class="item-meta"><span>${dateTime.format(new Date(item.createdAt))}</span></div>
      </div>
    `).join("")
    : empty("Nenhuma mensagem com falha.");
}

function renderFailedPayments(payments) {
  const target = document.getElementById("failed-payments");
  target.innerHTML = payments.length
    ? payments.map((item) => `
      <div class="list-item">
        <div class="item-title">
          <span>${escapeHtml(item.customer)}</span>
          ${statusBadge("FAILED", "error")}
        </div>
        <div class="item-meta">
          <span>${formatMoney(item.amountCents)}</span>
          <span>${escapeHtml(item.provider || "sem provider")}</span>
          <span>${dateTime.format(new Date(item.createdAt))}</span>
        </div>
      </div>
    `).join("")
    : empty("Nenhum pagamento com falha.");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: state.token ? { "x-admin-token": state.token } : {},
  });

  if (response.status === 403 && options.allowForbidden) {
    return { protected: true, authenticated: false };
  }

  if (!response.ok) {
    throw new Error(`Falha ${response.status} ao carregar ${path}`);
  }

  return response.json();
}

function metricCard(label, value) {
  return `<div class="metric-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`;
}

function statusBadge(label, tone = "ok") {
  return `<span class="badge ${tone}">${escapeHtml(String(label))}</span>`;
}

function empty(message) {
  return `<div class="empty-state">${escapeHtml(message)}</div>`;
}

function formatMoney(cents) {
  return currency.format((Number(cents) || 0) / 100);
}

function orderStatusTone(status) {
  if (["PAID", "DELIVERED"].includes(status)) return "ok";
  if (["CANCELLED"].includes(status)) return "error";
  return "warn";
}

function paymentStatusTone(status) {
  if (status === "PAID") return "ok";
  if (["FAILED", "CANCELLED", "EXPIRED"].includes(status)) return "error";
  return "warn";
}

function setAuthState(text) {
  document.getElementById("auth-state").textContent = text;
}

function showAuth() {
  document.getElementById("auth-modal").classList.remove("hidden");
}

function hideAuth() {
  document.getElementById("auth-modal").classList.add("hidden");
  document.getElementById("auth-error").textContent = "";
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 3200);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
