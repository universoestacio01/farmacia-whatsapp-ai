const state = {
  section: "overview",
  token: localStorage.getItem("raia_admin_token") || "",
  conversations: [],
  orders: [],
  pendingPayments: [],
  selectedConversationId: null,
  selectedOrderId: null,
  pendingConfirmationOrder: null,
  medicinePriorityRules: [],
  refreshTimer: null,
};

const pageTitleBySection = {
  overview: "Visão geral",
  payments: "Compensações",
  attention: "Fila de atenção",
  conversations: "Conversas",
  orders: "Pedidos",
  "medicine-priorities": "Prioridades de medicamentos",
  providers: "Integrações",
  errors: "Erros",
};

const orderStatusLabel = {
  CONFIRMED: "Confirmado",
  PENDING_PAYMENT_MANUAL: "Aguardando Pix",
  PAID: "Pagamento confirmado",
  DELIVERED: "Entregue",
  CANCELLED: "Cancelado",
};

const paymentStatusLabel = {
  PENDING: "Aguardando compensação",
  PAID: "Compensado",
  FAILED: "Falhou",
  CANCELLED: "Cancelado",
  EXPIRED: "Expirado",
};

const conversationStateLabel = {
  IDLE: "Atendimento livre",
  WAITING_MEDICINE_NAME: "Aguardando produto",
  WAITING_PRESENTATION: "Aguardando opção",
  WAITING_QUANTITY: "Aguardando quantidade",
  WAITING_CEP: "Aguardando CEP",
  WAITING_ADDRESS_NUMBER: "Aguardando número",
  WAITING_CONFIRMATION: "Aguardando confirmação",
  WAITING_PIX: "Aguardando Pix",
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
  try {
    const session = await api("/admin/api/session", { allowForbidden: true });

    if (session.protected && !session.authenticated) {
      showAuth();
      setAuthState("Acesso protegido");
      return;
    }

    hideAuth();
    setAuthState(session.protected ? "Acesso protegido" : "Acesso sem token");
    await refresh();
    startAutoRefresh();
  } catch (error) {
    showToast(error.message || "Não foi possível iniciar o painel.");
  }
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

    try {
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
      startAutoRefresh();
    } catch (error) {
      document.getElementById("auth-error").textContent =
        error.message || "Não foi possível validar o acesso.";
    }
  });
}

function bindActions() {
  document.getElementById("refresh-button").addEventListener("click", refresh);
  document.getElementById("database-check-button").addEventListener("click", checkDatabase);
  document
    .getElementById("conversation-search")
    .addEventListener("input", debounce(loadConversations, 350));
  document.getElementById("conversation-state").addEventListener("change", loadConversations);
  document.getElementById("conversation-status").addEventListener("change", loadConversations);
  document.getElementById("manual-message-form").addEventListener("submit", sendManualMessage);
  document
    .getElementById("reset-conversation-button")
    .addEventListener("click", resetSelectedConversation);
  document
    .getElementById("close-conversation-button")
    .addEventListener("click", closeSelectedConversation);
  document.getElementById("order-status-select").addEventListener("change", updateSelectedOrderStatus);
  document.getElementById("order-search").addEventListener("input", renderFilteredOrders);
  document.getElementById("order-status-filter").addEventListener("change", renderFilteredOrders);
  document.getElementById("payment-status-filter").addEventListener("change", renderFilteredOrders);
  document
    .getElementById("save-medicine-priorities-button")
    .addEventListener("click", saveMedicinePriorities);
  document
    .getElementById("confirm-payment-submit")
    .addEventListener("click", confirmSelectedPayment);
  document.getElementById("confirm-payment-dialog").addEventListener("close", () => {
    state.pendingConfirmationOrder = null;
  });
  document.getElementById("logout-button").addEventListener("click", () => {
    localStorage.removeItem("raia_admin_token");
    state.token = "";
    stopAutoRefresh();
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
  const button = document.getElementById("refresh-button");
  button.disabled = true;
  button.textContent = "Atualizando...";

  try {
    if (state.section === "overview") await loadOverview();
    if (state.section === "payments") await loadPendingPayments();
    if (state.section === "attention") await loadAttention();
    if (state.section === "conversations") await loadConversations();
    if (state.section === "orders") await loadOrders();
    if (state.section === "medicine-priorities") await loadMedicinePriorities();
    if (state.section === "providers") await loadProviders();
    if (state.section === "errors") await loadErrors();

    document.getElementById("last-updated").textContent = `Atualizado ${dateTime.format(new Date())}`;
  } catch (error) {
    showToast(error.message || "Falha ao atualizar o painel.");
  } finally {
    button.disabled = false;
    button.textContent = "Atualizar";
  }
}

async function loadOverview() {
  const data = await api("/admin/api/overview");
  state.pendingPayments = data.pendingPaymentsQueue || [];
  renderMetrics(data.cards);
  renderPendingPayments(document.getElementById("overview-payment-queue"), state.pendingPayments, true);
  renderAttentionList(document.getElementById("latest-attention"), data.attention || [], false);
  renderConversationList(
    document.getElementById("latest-conversations"),
    data.latestConversations || [],
    false,
  );
  renderOrders(document.getElementById("latest-orders"), data.latestOrders || [], "list");
  updatePendingNavCount(data.cards?.pendingPayments || state.pendingPayments.length);
}

async function loadPendingPayments() {
  state.pendingPayments = await api("/admin/api/orders/pending-payments?limit=100");
  renderPendingPayments(document.getElementById("pending-payments-list"), state.pendingPayments, false);
  document.getElementById("pending-payments-summary").textContent = state.pendingPayments.length
    ? `${state.pendingPayments.length} pedido(s) aguardando conferência`
    : "Fila em dia";
  updatePendingNavCount(state.pendingPayments.length);
}

async function loadAttention() {
  const items = await api("/admin/api/attention?limit=50");
  renderAttentionList(document.getElementById("attention-list"), items, true);
}

async function loadConversations() {
  const params = new URLSearchParams({
    limit: "50",
    search: document.getElementById("conversation-search").value.trim(),
    state: document.getElementById("conversation-state").value,
    status: document.getElementById("conversation-status").value,
  });
  state.conversations = await api(`/admin/api/conversations?${params.toString()}`);
  renderConversationList(document.getElementById("conversation-list"), state.conversations, true);
}

async function loadOrders() {
  state.orders = await api("/admin/api/orders?limit=150");
  renderFilteredOrders();
  updatePendingNavCount(
    state.orders.filter((order) => order.payment?.status === "PENDING").length,
  );
}

async function loadProviders() {
  renderProviders(await api("/admin/api/providers"));
}

async function loadMedicinePriorities() {
  const data = await api("/admin/api/medicine-priorities");
  state.medicinePriorityRules = data.rules || [];
  document.getElementById("medicine-priorities-meta").innerHTML = `
    <span>Fonte: ${escapeHtml(data.source === "database" ? "banco de dados" : "padrão do sistema")}</span>
    <span>${state.medicinePriorityRules.length} regra(s)</span>
  `;
  document.getElementById("medicine-priorities-editor").value = JSON.stringify(
    state.medicinePriorityRules,
    null,
    2,
  );
}

async function saveMedicinePriorities() {
  const editor = document.getElementById("medicine-priorities-editor");
  let rules;

  try {
    rules = JSON.parse(editor.value);
  } catch {
    showToast("O JSON das prioridades está inválido.");
    return;
  }

  if (!Array.isArray(rules)) {
    showToast("As prioridades precisam estar em uma lista.");
    return;
  }

  const result = await api("/admin/api/medicine-priorities", {
    method: "PUT",
    body: { rules },
  });
  state.medicinePriorityRules = result.rules || [];
  editor.value = JSON.stringify(state.medicinePriorityRules, null, 2);
  document.getElementById("medicine-priorities-meta").innerHTML = `
    <span>Fonte: banco de dados</span>
    <span>${state.medicinePriorityRules.length} regra(s)</span>
  `;
  showToast("Prioridades salvas.");
}

async function loadErrors() {
  const data = await api("/admin/api/errors?limit=40");
  renderErrorSummary(data.summary);
  renderFailedMessages(data.failedMessages || []);
  renderFailedPayments(data.failedPayments || []);
}

async function checkDatabase() {
  const button = document.getElementById("database-check-button");
  button.disabled = true;
  button.textContent = "Testando...";

  try {
    const result = await api("/admin/api/database");
    document.getElementById("database-result").innerHTML = `
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
  } finally {
    button.disabled = false;
    button.textContent = "Testar banco";
  }
}

function renderMetrics(cards = {}) {
  const items = [
    ["Conversas abertas", cards.openConversations, "Atendimentos disponíveis", ""],
    ["Em atendimento", cards.activeConversations, "Com etapa pendente", ""],
    ["Mensagens em 24h", cards.messages24h, "Entrada e saída", ""],
    ["Falhas em 24h", cards.failedMessages24h, "Precisam de revisão", cards.failedMessages24h ? "critical" : "positive"],
    ["Pedidos hoje", cards.ordersToday, "Criados nas últimas 24h", ""],
    ["Pix pendentes", cards.pendingPayments, "Aguardando compensação", cards.pendingPayments ? "attention" : "positive"],
    ["Pedidos pagos", cards.paidOrders, "Pagamentos confirmados", "positive"],
    ["Receita confirmada", formatMoney(cards.paidRevenueCents), "Total compensado", "positive"],
  ];

  document.getElementById("metrics-grid").innerHTML = items
    .map(([label, value, helper, tone]) => metricCard(label, value, helper, tone))
    .join("");
}

function renderPendingPayments(target, orders, compact) {
  if (!orders.length) {
    target.innerHTML = empty("Nenhum Pix aguardando conferência.");
    return;
  }

  target.innerHTML = orders
    .map((order) => {
      const itemSummary = renderOrderItemPreview(order.items);
      const lateClass = order.waitingMinutes >= 30 ? "is-late" : "";
      return `
        <div class="payment-row ${lateClass}" data-pending-order-id="${escapeHtml(order.id)}">
          <div class="payment-main">
            <div class="payment-customer">
              <strong>${escapeHtml(order.customer.name || "Cliente WhatsApp")}</strong>
              <p>${escapeHtml(order.customer.whatsappNumber)} · ${escapeHtml(itemSummary)}</p>
              ${order.proofReceived ? statusBadge("Comprovante recebido", "info") : ""}
            </div>
          </div>
          <div class="payment-value">
            <strong>${formatMoney(order.totalCents)}</strong>
            <p>${formatWaitingTime(order.waitingMinutes)}</p>
          </div>
          <div class="payment-actions">
            <button class="primary-button compact-button" data-confirm-payment-id="${escapeHtml(order.id)}" type="button">
              Compensou
            </button>
            ${compact ? "" : `<button class="link-button" data-open-order-id="${escapeHtml(order.id)}" type="button">Ver pedido</button>`}
          </div>
        </div>
      `;
    })
    .join("");

  bindPaymentQueueActions(target, orders);
}

function bindPaymentQueueActions(target, orders) {
  target.querySelectorAll("[data-confirm-payment-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const order = orders.find((item) => item.id === button.dataset.confirmPaymentId);
      if (order) openConfirmPayment(order);
    });
  });

  target.querySelectorAll("[data-open-order-id]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      setSection("orders");
      await selectOrder(button.dataset.openOrderId);
    });
  });

  target.querySelectorAll("[data-pending-order-id]").forEach((row) => {
    row.addEventListener("click", async () => {
      setSection("orders");
      await selectOrder(row.dataset.pendingOrderId);
    });
  });
}

function renderConversationList(target, conversations, selectable) {
  if (!conversations.length) {
    target.innerHTML = empty("Nenhuma conversa encontrada.");
    return;
  }

  target.innerHTML = conversations
    .map((conversation) => `
      <div class="list-item" ${selectable ? `data-conversation-id="${escapeHtml(conversation.id)}"` : ""}>
        <div class="item-title">
          <span>${escapeHtml(conversation.customerName || conversation.whatsappNumber)}</span>
          ${statusBadge(
            conversationStateLabel[conversation.pendingAction] || conversation.pendingAction,
            conversation.pendingAction === "IDLE" ? "ok" : "warn",
          )}
        </div>
        <p class="muted">${escapeHtml(conversation.lastMessage?.content || "Sem mensagens")}</p>
        <div class="item-meta">
          <span>${escapeHtml(conversation.whatsappNumber)}</span>
          <span>${formatDate(conversation.updatedAt)}</span>
          ${conversation.cartItems ? `<span>${conversation.cartItems} item(ns) no carrinho</span>` : ""}
          ${conversation.currentMedicineQuery ? `<span>${escapeHtml(conversation.currentMedicineQuery)}</span>` : ""}
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
      <div class="list-item" ${selectable ? `data-attention-conversation-id="${escapeHtml(item.id)}"` : ""}>
        <div class="item-title">
          <span>${escapeHtml(item.customerName || item.whatsappNumber)}</span>
          ${statusBadge(item.reason, "warn")}
        </div>
        <p class="muted">${escapeHtml(item.lastMessage || "Sem última mensagem")}</p>
        <div class="item-meta">
          <span>${escapeHtml(item.whatsappNumber)}</span>
          <span>${formatDate(item.updatedAt)}</span>
          <span>${escapeHtml(conversationStateLabel[item.pendingAction] || item.pendingAction)}</span>
        </div>
      </div>
    `)
    .join("");

  if (selectable) {
    target.querySelectorAll("[data-attention-conversation-id]").forEach((item) => {
      item.addEventListener("click", async () => {
        setSection("conversations");
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
    ? `${conversation.whatsappNumber} · ${conversationStateLabel[conversation.pendingAction] || conversation.pendingAction}`
    : "Conversa selecionada";
  document.getElementById("conversation-actions").classList.remove("hidden");
  document.getElementById("manual-message-form").classList.remove("hidden");

  const messages = await api(`/admin/api/conversations/${id}/messages?limit=100`);
  const thread = document.getElementById("message-thread");

  if (!messages.length) {
    thread.className = "message-thread empty-state";
    thread.textContent = "Sem mensagens para exibir.";
    return;
  }

  thread.className = "message-thread";
  thread.innerHTML = messages
    .map((message) => {
      const proofClass = String(message.content).toLowerCase().includes("comprovante")
        ? "payment-proof"
        : "";
      return `
        <div class="message ${message.direction === "OUTBOUND" ? "outbound" : "inbound"} ${proofClass}">
          ${escapeHtml(message.content)}
          <small>${message.direction === "OUTBOUND" ? "Raia Delivery" : "Cliente"} · ${escapeHtml(message.status)} · ${formatDate(message.createdAt)}</small>
        </div>
      `;
    })
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
  await api(`/admin/api/conversations/${state.selectedConversationId}/reset`, { method: "POST" });
  await loadConversations();
  await selectConversation(state.selectedConversationId);
  showToast("Conversa reiniciada.");
}

async function closeSelectedConversation() {
  if (!state.selectedConversationId) return;
  await api(`/admin/api/conversations/${state.selectedConversationId}/close`, { method: "POST" });
  await loadConversations();
  document.getElementById("message-thread").className = "message-thread empty-state";
  document.getElementById("message-thread").textContent = "Conversa encerrada.";
  document.getElementById("manual-message-form").classList.add("hidden");
  document.getElementById("conversation-actions").classList.add("hidden");
  showToast("Conversa encerrada.");
}

function renderFilteredOrders() {
  const search = document.getElementById("order-search").value.trim().toLowerCase();
  const orderStatus = document.getElementById("order-status-filter").value;
  const paymentStatus = document.getElementById("payment-status-filter").value;
  const filtered = state.orders.filter((order) => {
    const searchable = [
      order.id,
      order.customer?.name,
      order.customer?.whatsappNumber,
      ...(order.items || []).flatMap((item) => [item.name, item.brand, item.presentation]),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return (
      (!search || searchable.includes(search)) &&
      (!orderStatus || order.status === orderStatus) &&
      (!paymentStatus || order.payment?.status === paymentStatus)
    );
  });

  document.getElementById("orders-result-count").textContent = `${filtered.length} pedido(s)`;
  renderOrders(document.getElementById("orders-table"), filtered, "table");
}

function renderOrders(target, orders, mode) {
  if (!orders.length) {
    target.innerHTML = empty("Nenhum pedido encontrado.");
    return;
  }

  if (mode === "table") {
    target.innerHTML = orders
      .map((order) => {
        const isPending = order.payment?.status === "PENDING";
        return `
          <div class="table-row selectable-row" data-order-id="${escapeHtml(order.id)}">
            <div>
              <strong>${escapeHtml(order.customer.name || "Cliente WhatsApp")}</strong>
              <div class="muted">${escapeHtml(order.customer.whatsappNumber)}</div>
              <div class="muted">${escapeHtml(renderOrderItemPreview(order.items))}</div>
            </div>
            <div>${statusBadge(orderStatusLabel[order.status] || order.status, orderStatusTone(order.status))}</div>
            <div>
              <strong>${formatMoney(order.totalCents)}</strong>
              <div class="muted">${formatDate(order.createdAt)}</div>
            </div>
            <div class="hide-tablet">
              ${statusBadge(paymentStatusLabel[order.payment?.status] || "Sem pagamento", paymentStatusTone(order.payment?.status))}
            </div>
            <div class="row-action">
              ${isPending ? `<button class="primary-button compact-button" data-table-confirm-payment-id="${escapeHtml(order.id)}" type="button">Compensou</button>` : `<button class="secondary-button compact-button" data-view-order-id="${escapeHtml(order.id)}" type="button">Ver</button>`}
            </div>
          </div>
        `;
      })
      .join("");

    target.querySelectorAll("[data-order-id]").forEach((item) => {
      item.addEventListener("click", () => selectOrder(item.dataset.orderId));
    });
    target.querySelectorAll("[data-table-confirm-payment-id]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const order = orders.find((item) => item.id === button.dataset.tableConfirmPaymentId);
        if (order) openConfirmPayment(order);
      });
    });
    target.querySelectorAll("[data-view-order-id]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        selectOrder(button.dataset.viewOrderId);
      });
    });
    return;
  }

  target.innerHTML = orders
    .map((order) => `
      <div class="list-item">
        <div class="item-title">
          <span>${escapeHtml(order.customer.name || order.customer.whatsappNumber)}</span>
          ${statusBadge(orderStatusLabel[order.status] || order.status, orderStatusTone(order.status))}
        </div>
        <div class="item-meta">
          <span>${formatMoney(order.totalCents)}</span>
          <span>${escapeHtml(paymentStatusLabel[order.payment?.status] || "Sem pagamento")}</span>
          <span>${formatDate(order.createdAt)}</span>
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

  const pendingPayment = order.payments.find((payment) => payment.status === "PENDING");
  const paidPayment = order.payments.find((payment) => payment.status === "PAID");
  statusSelect.classList.remove("hidden");
  statusSelect.value = order.status;
  target.className = "order-detail";
  target.innerHTML = `
    <div class="order-payment-hero ${paidPayment ? "paid" : ""}">
      <div>
        <span class="muted">${paidPayment ? "Pagamento confirmado" : pendingPayment ? "Aguardando conferência" : "Situação do pedido"}</span>
        <strong>${formatMoney(order.totalCents)}</strong>
      </div>
      ${pendingPayment ? `<button class="primary-button" id="detail-confirm-payment" type="button">Confirmar que compensou</button>` : statusBadge(orderStatusLabel[order.status] || order.status, orderStatusTone(order.status))}
    </div>
    <div class="detail-block">
      <h3>Cliente</h3>
      <strong>${escapeHtml(order.customer.name || "Cliente WhatsApp")}</strong>
      <div class="item-meta">
        <span>${escapeHtml(order.customer.whatsappNumber)}</span>
        <span>Pedido ${escapeHtml(shortId(order.id))}</span>
        <span>${formatDate(order.createdAt)}</span>
      </div>
    </div>
    <div class="detail-block">
      <h3>Itens</h3>
      ${renderOrderItems(order.items)}
    </div>
    <div class="detail-block">
      <h3>Entrega</h3>
      ${renderAddress(order.notes?.address)}
    </div>
    <div class="detail-block">
      <h3>Pagamentos</h3>
      ${renderPaymentHistory(order.payments)}
    </div>
  `;

  document.getElementById("detail-confirm-payment")?.addEventListener("click", () =>
    openConfirmPayment({
      ...order,
      payment: pendingPayment,
    }),
  );
}

async function updateSelectedOrderStatus() {
  if (!state.selectedOrderId) return;
  const select = document.getElementById("order-status-select");
  const status = select.value;
  if (status === "PAID") {
    showToast("Use o botão “Confirmar que compensou” para registrar o pagamento.");
    return;
  }

  await api(`/admin/api/orders/${state.selectedOrderId}/status`, {
    method: "PATCH",
    body: { status },
  });
  await loadOrders();
  await selectOrder(state.selectedOrderId);
  showToast("Status do pedido atualizado.");
}

function openConfirmPayment(order) {
  state.pendingConfirmationOrder = order;
  const customer = order.customer?.name || order.customer?.whatsappNumber || "Cliente WhatsApp";
  document.getElementById("confirm-payment-description").textContent =
    `Confirme somente depois de conferir o recebimento no banco. O pedido de ${customer} seguirá para separação.`;
  document.getElementById("confirm-payment-summary").innerHTML = `
    <div><span>Pedido</span><strong>${escapeHtml(shortId(order.id))}</strong></div>
    <div><span>Valor</span><strong>${formatMoney(order.totalCents)}</strong></div>
    <div><span>Cliente</span><strong>${escapeHtml(customer)}</strong></div>
  `;
  document.getElementById("confirm-payment-dialog").showModal();
}

async function confirmSelectedPayment() {
  const order = state.pendingConfirmationOrder;
  if (!order) return;

  const button = document.getElementById("confirm-payment-submit");
  button.disabled = true;
  button.textContent = "Confirmando...";

  try {
    const result = await api(`/admin/api/orders/${order.id}/confirm-payment`, { method: "POST" });
    document.getElementById("confirm-payment-dialog").close();

    if (result.alreadyConfirmed) {
      showToast("Este pagamento já estava confirmado.");
    } else if (result.notificationStatus === "SENT") {
      showToast("Pagamento confirmado e cliente avisado.");
    } else if (result.notificationQueued) {
      showToast("Pagamento confirmado. O aviso entrou na fila do WhatsApp.");
    } else {
      showToast("Pagamento confirmado. Revise o envio do aviso ao cliente.");
    }

    await refresh();
    if (state.section === "orders" && state.selectedOrderId === order.id) {
      await selectOrder(order.id);
    }
  } catch (error) {
    showToast(error.message || "Não foi possível confirmar o pagamento.");
  } finally {
    button.disabled = false;
    button.textContent = "Sim, compensou";
  }
}

function renderOrderItemPreview(items) {
  if (!Array.isArray(items) || items.length === 0) return "Sem itens no resumo";
  return items
    .slice(0, 2)
    .map((item) => `${Number(item.quantity) || 1}x ${item.name || item.description || "Item"}`)
    .join(", ");
}

function renderOrderItems(items) {
  if (!Array.isArray(items) || !items.length) {
    return '<p class="muted">Sem itens registrados no pedido.</p>';
  }

  return items
    .map((item, index) => `
      <div class="list-item">
        <div class="item-title">
          <span>${index + 1}. ${escapeHtml(item.name || item.description || "Item")}</span>
          <strong>${formatMoney(item.totalCents)}</strong>
        </div>
        <div class="item-meta">
          <span>${Number(item.quantity) || 1} un</span>
          <span>${formatMoney(item.unitPriceCents)} cada</span>
          ${item.presentation ? `<span>${escapeHtml(item.presentation)}</span>` : ""}
          ${item.brand ? `<span>${escapeHtml(item.brand)}</span>` : ""}
        </div>
      </div>
    `)
    .join("");
}

function renderPaymentHistory(payments) {
  if (!payments.length) return '<p class="muted">Sem pagamento registrado.</p>';
  return payments
    .map((payment) => `
      <div class="list-item">
        <div class="item-title">
          <span>${payment.provider === "pix_direct" ? "Pix direto" : escapeHtml(payment.provider || "Pagamento")}</span>
          ${statusBadge(paymentStatusLabel[payment.status] || payment.status, paymentStatusTone(payment.status))}
        </div>
        <div class="item-meta">
          <span>${formatMoney(payment.amountCents)}</span>
          <span>Criado em ${formatDate(payment.createdAt)}</span>
          ${payment.paidAt ? `<span>Compensado em ${formatDate(payment.paidAt)}</span>` : ""}
        </div>
      </div>
    `)
    .join("");
}

function renderAddress(address) {
  if (!address || typeof address !== "object") {
    return '<p class="muted">Sem endereço registrado.</p>';
  }

  const street = address.logradouro || address.street || "";
  const neighborhood = address.bairro || address.neighborhood || "";
  const city = address.localidade || address.city || "";
  const stateValue = address.uf || address.state || "";
  return `
    <p><strong>${escapeHtml(street)}${address.number ? `, número ${escapeHtml(address.number)}` : ""}</strong></p>
    <div class="item-meta">
      ${address.cep ? `<span>CEP ${escapeHtml(address.cep)}</span>` : ""}
      ${neighborhood ? `<span>${escapeHtml(neighborhood)}</span>` : ""}
      ${city || stateValue ? `<span>${escapeHtml(city)}${stateValue ? `/${escapeHtml(stateValue)}` : ""}</span>` : ""}
      ${address.complement ? `<span>${escapeHtml(address.complement)}</span>` : ""}
    </div>
  `;
}

function renderProviders(data) {
  const providers = [
    ["Banco de dados", data.database.configured, "Uso sob demanda"],
    ["WhatsApp", data.whatsapp.configured, `Cloud API ${data.whatsapp.apiVersion}`],
    ["PharmaDB", data.medicines.pharmadbConfigured, `Principal: ${data.medicines.primaryProvider}`],
    ["BulAPI", data.medicines.bulapiConfigured, "Fallback de medicamentos"],
    ["Cosmos", data.retailProducts.cosmosConfigured, `${data.retailProducts.cosmosTokenCount} token(s)`],
    ["Pix direto", data.payments.directPixConfigured, "Valor individual por pedido; conferência manual"],
    ["Painel", data.admin.protected, data.admin.protected ? "Protegido" : "ADMIN_TOKEN ausente"],
  ];

  document.getElementById("providers-grid").innerHTML = providers
    .map(([name, configured, detail]) => `
      <div class="provider-card">
        <div class="item-title">
          <h3>${escapeHtml(name)}</h3>
          ${statusBadge(configured ? "Configurado" : "Atenção", configured ? "ok" : "warn")}
        </div>
        <p class="muted">${escapeHtml(String(detail))}</p>
        <div class="item-meta"><span>Não chamado no bootstrap</span></div>
      </div>
    `)
    .join("");
}

function renderErrorSummary(summary) {
  const items = [
    ["Mensagens com falha", summary.failedMessages, "Envios que precisam de revisão", summary.failedMessages ? "critical" : "positive"],
    ["Pagamentos com falha", summary.failedPayments, "Registros com erro", summary.failedPayments ? "critical" : "positive"],
    ["Pix pendentes", summary.pendingPayments, "Fila de compensação", summary.pendingPayments ? "attention" : "positive"],
    ["Pedidos cancelados", summary.cancelledOrders, "Histórico total", ""],
  ];
  document.getElementById("errors-summary").innerHTML = items
    .map(([label, value, helper, tone]) => metricCard(label, value, helper, tone))
    .join("");
}

function renderFailedMessages(messages) {
  const target = document.getElementById("failed-messages");
  target.innerHTML = messages.length
    ? messages
        .map((item) => `
          <div class="list-item">
            <div class="item-title"><span>${escapeHtml(item.customer)}</span>${statusBadge("Falhou", "error")}</div>
            <p class="muted">${escapeHtml(item.content)}</p>
            <div class="item-meta"><span>${formatDate(item.createdAt)}</span></div>
          </div>
        `)
        .join("")
    : empty("Nenhuma mensagem com falha.");
}

function renderFailedPayments(payments) {
  const target = document.getElementById("failed-payments");
  target.innerHTML = payments.length
    ? payments
        .map((item) => `
          <div class="list-item">
            <div class="item-title"><span>${escapeHtml(item.customer)}</span>${statusBadge("Falhou", "error")}</div>
            <div class="item-meta">
              <span>${formatMoney(item.amountCents)}</span>
              <span>${escapeHtml(item.provider || "sem provedor")}</span>
              <span>${formatDate(item.createdAt)}</span>
            </div>
          </div>
        `)
        .join("")
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

  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message = Array.isArray(body?.message)
      ? body.message.join(" ")
      : body?.message || body?.error || `Falha ${response.status} ao carregar ${path}`;
    throw new Error(message);
  }

  return body;
}

function startAutoRefresh() {
  stopAutoRefresh();
  state.refreshTimer = window.setInterval(() => {
    const dialog = document.getElementById("confirm-payment-dialog");
    if (!document.hidden && !dialog.open) refresh();
  }, 30000);
}

function stopAutoRefresh() {
  if (state.refreshTimer) window.clearInterval(state.refreshTimer);
  state.refreshTimer = null;
}

function updatePendingNavCount(count) {
  const badge = document.getElementById("pending-nav-count");
  badge.textContent = String(count || 0);
  badge.classList.toggle("hidden", !count);
}

function metricCard(label, value, helper = "", tone = "") {
  return `
    <div class="metric-card ${tone}">
      <span class="metric-label">${escapeHtml(label)}</span>
      <strong>${escapeHtml(String(value ?? 0))}</strong>
      ${helper ? `<small>${escapeHtml(helper)}</small>` : ""}
    </div>
  `;
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

function formatDate(value) {
  if (!value) return "Sem data";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Sem data" : dateTime.format(parsed);
}

function formatWaitingTime(minutes) {
  const safeMinutes = Math.max(0, Number(minutes) || 0);
  if (safeMinutes < 1) return "Agora";
  if (safeMinutes < 60) return `Há ${safeMinutes} min`;
  if (safeMinutes >= 24 * 60) {
    const days = Math.floor(safeMinutes / (24 * 60));
    return `Há ${days} dia${days === 1 ? "" : "s"}`;
  }
  const hours = Math.floor(safeMinutes / 60);
  const remainder = safeMinutes % 60;
  return `Há ${hours}h${remainder ? ` ${remainder}min` : ""}`;
}

function shortId(id) {
  return String(id || "").slice(-8).toUpperCase();
}

function orderStatusTone(status) {
  if (["PAID", "DELIVERED"].includes(status)) return "ok";
  if (status === "CANCELLED") return "error";
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

let toastTimer;
function showToast(message) {
  const toast = document.getElementById("toast");
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("show");
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 3800);
}

function debounce(callback, wait) {
  let timer;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => callback(...args), wait);
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
