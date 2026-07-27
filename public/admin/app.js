const state = {
  section: "overview",
  token: localStorage.getItem("raia_admin_token") || "",
  conversations: [],
  selectedConversationId: null,
  selectedOrderId: null,
};

const pageTitleBySection = {
  overview: "Visão geral",
  attention: "Fila de atenção",
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
  document.getElementById("conversation-search").addEventListener("input", debounce(loadConversations, 350));
  document.getElementById("conversation-state").addEventListener("change", loadConversations);
  document.getElementById("conversation-status").addEventListener("change", loadConversations);
  document.getElementById("manual-message-form").addEventListener("submit", sendManualMessage);
  document.getElementById("reset-conversation-button").addEventListener("click", resetSelectedConversation);
  document.getElementById("close-conversation-button").addEventListener("click", closeSelectedConversation);
  document.getElementById("order-status-select").addEventListener("change", updateSelectedOrderStatus);
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
    } else if (state.section === "attention") {
      await loadAttention();
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
  renderAttentionList(document.getElementById("latest-attention"), data.attention || [], false);
  renderConversationList(document.getElementById("latest-conversations"), data.latestConversations, false);
  renderOrders(document.getElementById("latest-orders"), data.latestOrders, "list");
}

async function loadAttention() {
  const items = await api("/admin/api/attention?limit=40");
  renderAttentionList(document.getElementById("attention-list"), items, true);
}

async function loadConversations() {
  const params = new URLSearchParams({
    limit: "30",
    search: document.getElementById("conversation-search").value.trim(),
    state: document.getElementById("conversation-state").value,
    status: document.getElementById("conversation-status").value,
  });
  state.conversations = await api(`/admin/api/conversations?${params.toString()}`);
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

function renderAttentionList(target, items, selectable) {
  if (!items.length) {
    target.innerHTML = empty("Nenhuma conversa pedindo atenção agora.");
    return;
  }

  target.innerHTML = items
    .map((item) => `
      <div class="list-item" ${selectable ? `data-attention-conversation-id="${item.id}"` : ""}>
        <div class="item-title">
          <span>${escapeHtml(item.customerName || item.whatsappNumber)}</span>
          ${statusBadge(item.reason, "warn")}
        </div>
        <p class="muted">${escapeHtml(item.lastMessage || "Sem última mensagem")}</p>
        <div class="item-meta">
          <span>${escapeHtml(item.whatsappNumber)}</span>
          <span>${dateTime.format(new Date(item.updatedAt))}</span>
          <span>${escapeHtml(item.pendingAction)}</span>
        </div>
      </div>
    `)
    .join("");

  if (selectable) {
    target.querySelectorAll("[data-attention-conversation-id]").forEach((item) => {
      item.addEventListener("click", async () => {
        setSection("conversations");
        document.getElementById("conversation-search").value = "";
        document.getElementById("conversation-state").value = "";
        document.getElementById("conversation-status").value = "";
        await loadConversations();
        await selectConversation(item.dataset.attentionConversationId);
      });
    });
  }
}

async function selectConversation(id) {
  state.selectedConversationId = id;
  document.querySelectorAll("[data-conversation-id]").forEach((item) => {
    item.classList.toggle("active", item.dataset.conversationId === id);
  });

  const conversation = state.conversations.find((item) => item.id === id);
  document.getElementById("conversation-context").textContent = conversation
    ? `${conversation.whatsappNumber} · ${conversation.pendingAction}`
    : "Conversa selecionada";
  document.getElementById("conversation-actions").classList.remove("hidden");
  document.getElementById("manual-message-form").classList.remove("hidden");

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

async function sendManualMessage(event) {
  event.preventDefault();

  if (!state.selectedConversationId) {
    showToast("Selecione uma conversa primeiro.");
    return;
  }

  const input = document.getElementById("manual-message-text");
  const text = input.value.trim();

  if (!text) {
    showToast("Digite uma mensagem para enviar.");
    return;
  }

  await api(`/admin/api/conversations/${state.selectedConversationId}/messages`, {
    method: "POST",
    body: { text },
  });
  input.value = "";
  await selectConversation(state.selectedConversationId);
  showToast("Mensagem enviada pelo WhatsApp.");
}

async function resetSelectedConversation() {
  if (!state.selectedConversationId) return;
  await api(`/admin/api/conversations/${state.selectedConversationId}/reset`, {
    method: "POST",
  });
  await loadConversations();
  await selectConversation(state.selectedConversationId);
  showToast("Conversa resetada.");
}

async function closeSelectedConversation() {
  if (!state.selectedConversationId) return;
  await api(`/admin/api/conversations/${state.selectedConversationId}/close`, {
    method: "POST",
  });
  await loadConversations();
  document.getElementById("message-thread").className = "message-thread empty-state";
  document.getElementById("message-thread").textContent = "Conversa fechada.";
  document.getElementById("manual-message-form").classList.add("hidden");
  document.getElementById("conversation-actions").classList.add("hidden");
  showToast("Conversa fechada.");
}

function renderOrders(target, orders, mode) {
  if (!orders.length) {
    target.innerHTML = empty("Nenhum pedido encontrado.");
    return;
  }

  if (mode === "table") {
    target.innerHTML = orders
      .map((order) => `
        <div class="table-row selectable-row" data-order-id="${order.id}">
          <div>
            <strong>${escapeHtml(order.customer.whatsappNumber)}</strong>
            <div class="muted">${escapeHtml(order.customer.name || "Cliente WhatsApp")}</div>
            <div class="muted">${renderOrderItemPreview(order.notes?.items)}</div>
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
    target.querySelectorAll("[data-order-id]").forEach((item) => {
      item.addEventListener("click", () => selectOrder(item.dataset.orderId));
    });
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

async function selectOrder(id) {
  state.selectedOrderId = id;
  document.querySelectorAll("[data-order-id]").forEach((item) => {
    item.classList.toggle("active", item.dataset.orderId === id);
  });

  const order = await api(`/admin/api/orders/${id}`);
  const target = document.getElementById("order-detail");
  const statusSelect = document.getElementById("order-status-select");

  if (!order) {
    target.className = "empty-state";
    target.textContent = "Pedido não encontrado.";
    statusSelect.classList.add("hidden");
    return;
  }

  statusSelect.classList.remove("hidden");
  statusSelect.value = order.status;
  target.className = "order-detail";
  target.innerHTML = `
    <div class="detail-block">
      <h3>Cliente</h3>
      <strong>${escapeHtml(order.customer.name || "Cliente WhatsApp")}</strong>
      <div class="muted">${escapeHtml(order.customer.whatsappNumber)}</div>
    </div>
    <div class="detail-block">
      <h3>Itens</h3>
      ${renderOrderItems(order.notes?.items)}
    </div>
    <div class="detail-block">
      <h3>Entrega</h3>
      ${renderAddress(order.notes?.address)}
    </div>
    <div class="detail-block">
      <h3>Pagamento</h3>
      <div class="item-meta">
        <span>Total: ${formatMoney(order.totalCents)}</span>
        <span>Status: ${escapeHtml(order.status)}</span>
      </div>
      ${order.payments.length ? order.payments.map((payment) => `
        <div class="list-item">
          <div class="item-title">
            <span>${escapeHtml(payment.provider || "sem provider")}</span>
            ${statusBadge(payment.status, paymentStatusTone(payment.status))}
          </div>
          <div class="item-meta">
            <span>${formatMoney(payment.amountCents)}</span>
            ${payment.providerTransactionId ? `<span>${escapeHtml(payment.providerTransactionId)}</span>` : ""}
            <span>${dateTime.format(new Date(payment.createdAt))}</span>
          </div>
        </div>
      `).join("") : "<p class=\"muted\">Sem pagamento registrado.</p>"}
    </div>
  `;
}

async function updateSelectedOrderStatus() {
  if (!state.selectedOrderId) return;
  const status = document.getElementById("order-status-select").value;
  await api(`/admin/api/orders/${state.selectedOrderId}/status`, {
    method: "PATCH",
    body: { status },
  });
  await loadOrders();
  await selectOrder(state.selectedOrderId);
  showToast("Status do pedido atualizado.");
}

function renderOrderItemPreview(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return "Sem itens no resumo";
  }

  return items
    .slice(0, 2)
    .map((item) => `${item.quantity || 1}x ${item.name || item.description || "Item"}`)
    .join(", ");
}

function renderOrderItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return "<p class=\"muted\">Sem itens registrados no pedido.</p>";
  }

  return items
    .map((item, index) => `
      <div class="list-item">
        <div class="item-title">
          <span>${index + 1}. ${escapeHtml(item.name || item.description || "Item")}</span>
          <span>${formatMoney(Math.round((Number(item.total) || 0) * 100))}</span>
        </div>
        <div class="item-meta">
          <span>${Number(item.quantity) || 1} un</span>
          ${item.unitPrice ? `<span>${currency.format(Number(item.unitPrice))} cada</span>` : ""}
          ${item.presentation ? `<span>${escapeHtml(item.presentation)}</span>` : ""}
          ${item.source ? `<span>${escapeHtml(item.source)}</span>` : ""}
        </div>
      </div>
    `)
    .join("");
}

function renderAddress(address) {
  if (!address || typeof address !== "object") {
    return "<p class=\"muted\">Sem endereço registrado.</p>";
  }

  const street = address.logradouro || address.street || "";
  const neighborhood = address.bairro || address.neighborhood || "";
  const city = address.localidade || address.city || "";
  const stateValue = address.uf || address.state || "";

  return `
    <p><strong>${escapeHtml(street)}, número ${escapeHtml(address.number || "")}</strong></p>
    <div class="item-meta">
      ${address.cep ? `<span>CEP ${escapeHtml(address.cep)}</span>` : ""}
      ${neighborhood ? `<span>${escapeHtml(neighborhood)}</span>` : ""}
      ${city || stateValue ? `<span>${escapeHtml(city)}/${escapeHtml(stateValue)}</span>` : ""}
      ${address.complement ? `<span>${escapeHtml(address.complement)}</span>` : ""}
    </div>
  `;
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
  const headers = {
    ...(state.token ? { "x-admin-token": state.token } : {}),
    ...(options.body ? { "Content-Type": "application/json" } : {}),
  };

  const response = await fetch(path, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (response.status === 403 && options.allowForbidden) {
    return { protected: true, authenticated: false };
  }

  if (!response.ok) {
    throw new Error(`Falha ${response.status} ao carregar ${path}`);
  }

  return response.json();
}

function debounce(callback, wait) {
  let timer;

  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => callback(...args), wait);
  };
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
