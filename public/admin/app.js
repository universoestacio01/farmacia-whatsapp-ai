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
  refreshing: new Set(),
  requests: new Map(),
  actions: new Set(),
  drafts: new Map(),
  providerLogs: [],
  prioritiesDirty: false,
  sessionVersion: 0,
  authenticated: false,
  loadedConversationId: null,
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
  WAITING_RETAIL_BRAND: "Aguardando marca",
  WAITING_PRESENTATION: "Aguardando opção",
  WAITING_QUANTITY: "Aguardando quantidade",
  WAITING_CEP: "Aguardando CEP",
  WAITING_ADDRESS_NUMBER: "Aguardando número",
  WAITING_ADDRESS_COMPLEMENT: "Aguardando complemento",
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
  window.lucide?.createIcons();
  await bootstrap();
});

async function bootstrap() {
  try {
    const session = await api("/admin/api/session", { allowForbidden: true });

    if (!session.authenticated) {
      showAuth();
      setAuthState("Acesso protegido");
      return;
    }

    state.authenticated = true;
    hideAuth();
    if (session.demo) {
      document.querySelector(".eyebrow").textContent =
        "Demonstração local · dados fictícios";
    }
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
    button.addEventListener("click", () =>
      setSection(button.dataset.sectionTarget),
    );
  });
}

function bindAuth() {
  document
    .getElementById("auth-form")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const token = document.getElementById("admin-token").value.trim();
      state.token = token;

      try {
        const session = await api("/admin/api/session", {
          allowForbidden: true,
        });

        if (!session.authenticated) {
          state.token = "";
          document.getElementById("auth-error").textContent = "Token inválido.";
          return;
        }

        localStorage.setItem("raia_admin_token", token);
        state.authenticated = true;
        document.getElementById("admin-token").value = "";
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
  document
    .getElementById("database-check-button")
    .addEventListener("click", handled(checkDatabase));
  document
    .getElementById("conversation-search")
    .addEventListener("input", debounce(loadConversations, 350));
  document
    .getElementById("conversation-state")
    .addEventListener("change", handled(loadConversations));
  document
    .getElementById("conversation-status")
    .addEventListener("change", handled(loadConversations));
  document
    .getElementById("manual-message-form")
    .addEventListener("submit", sendManualMessage);
  document
    .getElementById("reset-conversation-button")
    .addEventListener("click", resetSelectedConversation);
  document
    .getElementById("close-conversation-button")
    .addEventListener("click", closeSelectedConversation);
  document
    .getElementById("order-status-select")
    .addEventListener("change", updateSelectedOrderStatus);
  document
    .getElementById("order-search")
    .addEventListener("input", renderFilteredOrders);
  document
    .getElementById("order-status-filter")
    .addEventListener("change", renderFilteredOrders);
  document
    .getElementById("payment-status-filter")
    .addEventListener("change", renderFilteredOrders);
  document
    .getElementById("save-medicine-priorities-button")
    .addEventListener("click", saveMedicinePriorities);
  document
    .getElementById("confirm-payment-submit")
    .addEventListener("click", confirmSelectedPayment);
  document
    .getElementById("confirm-payment-dialog")
    .addEventListener("close", () => {
      state.pendingConfirmationOrder = null;
    });
  document.getElementById("logout-button").addEventListener("click", () => {
    endSession();
  });
  document
    .getElementById("auto-refresh")
    .addEventListener("change", (event) => {
      if (event.target.checked && state.authenticated) startAutoRefresh();
      else stopAutoRefresh();
    });
  document
    .getElementById("manual-message-text")
    .addEventListener("input", (event) => {
      if (state.loadedConversationId)
        state.drafts.set(state.loadedConversationId, event.target.value);
    });
  document
    .getElementById("medicine-priorities-editor")
    .addEventListener("input", () => setPrioritiesDirty(true));
  document.getElementById("discard-priorities-button").addEventListener(
    "click",
    handled(async () => {
      if (
        await askConfirmation(
          "Descartar alterações?",
          "As prioridades não salvas serão descartadas.",
        )
      ) {
        document.getElementById("medicine-priorities-editor").value =
          JSON.stringify(state.medicinePriorityRules, null, 2);
        setPrioritiesDirty(false);
      }
    }),
  );
  for (const id of ["payment-search", "proof-filter", "waiting-filter"]) {
    document
      .getElementById(id)
      .addEventListener("input", renderFilteredPayments);
  }
  for (const id of [
    "provider-log-search",
    "provider-log-provider",
    "provider-log-outcome",
  ]) {
    document.getElementById(id).addEventListener("input", renderProviderLogs);
  }
  window.addEventListener("beforeunload", (event) => {
    if (
      state.prioritiesDirty ||
      [...state.drafts.values()].some((draft) => draft.trim())
    ) {
      event.preventDefault();
      event.returnValue = "";
    }
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
  document.getElementById("page-title").textContent =
    pageTitleBySection[section] || "Painel";
  refresh();
}

async function refresh() {
  if (!state.authenticated) return;
  const section = state.section;
  if (state.refreshing.has(section)) return;
  state.refreshing.add(section);
  const button = document.getElementById("refresh-button");
  button.disabled = true;
  button.classList.add("is-refreshing");

  try {
    const loaders = {
      overview: loadOverview,
      payments: loadPendingPayments,
      attention: loadAttention,
      conversations: loadConversations,
      orders: loadOrders,
      "medicine-priorities": loadMedicinePriorities,
      providers: loadProviders,
      errors: loadErrors,
    };
    await loaders[section]?.();

    if (state.section === section) {
      document.getElementById("last-updated").textContent =
        `Atualizado ${dateTime.format(new Date())}`;
      document.querySelector(".live-dot").classList.remove("failed");
    }
  } catch (error) {
    if (error.name !== "AbortError") {
      document.getElementById("last-updated").textContent =
        "Atualização falhou";
      document.querySelector(".live-dot").classList.add("failed");
      reportError(error);
    }
  } finally {
    state.refreshing.delete(section);
    button.disabled = state.refreshing.has(state.section);
    button.classList.toggle("is-refreshing", button.disabled);
  }
}

async function loadOverview() {
  const data = await api("/admin/api/overview");
  state.pendingPayments = data.pendingPaymentsQueue || [];
  renderMetrics(data.cards);
  renderPendingPayments(
    document.getElementById("overview-payment-queue"),
    state.pendingPayments,
    true,
  );
  renderAttentionList(
    document.getElementById("latest-attention"),
    data.attention || [],
    false,
  );
  renderConversationList(
    document.getElementById("latest-conversations"),
    data.latestConversations || [],
    false,
  );
  renderOrders(
    document.getElementById("latest-orders"),
    data.latestOrders || [],
    "list",
  );
  updatePendingNavCount(
    data.cards?.pendingPayments || state.pendingPayments.length,
  );
}

async function loadPendingPayments() {
  state.pendingPayments = await api(
    "/admin/api/orders/pending-payments?limit=100",
  );
  renderFilteredPayments();
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
  state.conversations = await api(
    `/admin/api/conversations?${params.toString()}`,
  );
  renderConversationList(
    document.getElementById("conversation-list"),
    state.conversations,
    true,
  );
  if (state.selectedConversationId && state.section === "conversations") {
    await selectConversation(state.selectedConversationId, true);
  }
}

async function loadOrders() {
  state.orders = await api("/admin/api/orders?limit=150");
  renderFilteredOrders();
  if (state.selectedOrderId && state.section === "orders")
    await selectOrder(state.selectedOrderId, true);
}

async function loadProviders() {
  renderProviders(await api("/admin/api/providers"));
  state.providerLogs = await api("/admin/api/provider-request-logs?limit=100");
  const select = document.getElementById("provider-log-provider");
  const previous = select.value;
  select.innerHTML =
    '<option value="">Todas as APIs</option>' +
    [...new Set(state.providerLogs.map((item) => item.provider))]
      .sort()
      .map(
        (provider) =>
          `<option value="${escapeHtml(provider)}">${escapeHtml(providerName(provider))}</option>`,
      )
      .join("");
  select.value = previous;
  renderProviderLogs();
}

async function loadMedicinePriorities() {
  if (state.prioritiesDirty || state.actions.has("priorities")) return;
  const data = await api("/admin/api/medicine-priorities");
  if (state.prioritiesDirty || state.actions.has("priorities")) return;
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

  await runAction(
    "priorities",
    [
      "save-medicine-priorities-button",
      "medicine-priorities-editor",
      "discard-priorities-button",
    ],
    async () => {
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
      setPrioritiesDirty(false);
    },
  );
  document.getElementById("discard-priorities-button").disabled =
    !state.prioritiesDirty;
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
    [
      "Conversas abertas",
      cards.openConversations,
      "Atendimentos disponíveis",
      "",
    ],
    ["Em atendimento", cards.activeConversations, "Com etapa pendente", ""],
    ["Mensagens em 24h", cards.messages24h, "Entrada e saída", ""],
    [
      "Falhas em 24h",
      cards.failedMessages24h,
      "Precisam de revisão",
      cards.failedMessages24h ? "critical" : "positive",
    ],
    ["Pedidos hoje", cards.ordersToday, "Criados nas últimas 24h", ""],
    [
      "Pix pendentes",
      cards.pendingPayments,
      "Aguardando compensação",
      cards.pendingPayments ? "attention" : "positive",
    ],
    ["Pedidos pagos", cards.paidOrders, "Pagamentos confirmados", "positive"],
    [
      "Receita confirmada",
      formatMoney(cards.paidRevenueCents),
      "Total compensado",
      "positive",
    ],
  ];

  document.getElementById("metrics-grid").innerHTML = items
    .map(([label, value, helper, tone], index) =>
      metricCard(
        label,
        value,
        helper,
        tone,
        [
          "conversations",
          "attention",
          "conversations",
          "errors",
          "orders",
          "payments",
          "orders",
          "orders",
        ][index],
      ),
    )
    .join("");
  document.querySelectorAll("[data-metric-section]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.metricSection === "orders") {
        document.getElementById("order-status-filter").value = "";
        document.getElementById("payment-status-filter").value =
          button.textContent.includes("pagos") ||
          button.textContent.includes("Receita")
            ? "PAID"
            : "";
        document.getElementById("order-search").value = "";
      }
      setSection(button.dataset.metricSection);
    });
  });
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
      const order = orders.find(
        (item) => item.id === button.dataset.confirmPaymentId,
      );
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
    .map(
      (conversation) => `
      <div class="list-item ${conversation.id === state.selectedConversationId ? "active" : ""}" ${selectable ? `data-conversation-id="${escapeHtml(conversation.id)}" role="button" tabindex="0"` : ""}>
        <div class="item-title">
          <span>${escapeHtml(conversation.customerName || conversation.whatsappNumber)}</span>
          ${statusBadge(
            conversationStateLabel[conversation.pendingAction] ||
              conversation.pendingAction,
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
    `,
    )
    .join("");

  if (selectable) {
    target.querySelectorAll("[data-conversation-id]").forEach((item) => {
      item.addEventListener("click", () =>
        selectConversation(item.dataset.conversationId),
      );
    });
  }
}

function renderAttentionList(target, items, selectable) {
  if (!items.length) {
    target.innerHTML = empty("Nenhuma conversa pedindo atenção agora.");
    return;
  }

  target.innerHTML = items
    .map(
      (item) => `
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
    `,
    )
    .join("");

  if (selectable) {
    target
      .querySelectorAll("[data-attention-conversation-id]")
      .forEach((item) => {
        item.addEventListener(
          "click",
          handled(async () => {
            setSection("conversations");
            await loadConversations();
            await selectConversation(item.dataset.attentionConversationId);
          }),
        );
      });
  }
}

async function selectConversation(id, preserve = false) {
  try {
    const switched = state.selectedConversationId !== id;
    state.selectedConversationId = id;
    document.querySelectorAll("[data-conversation-id]").forEach((item) => {
      item.classList.toggle("active", item.dataset.conversationId === id);
    });

    const conversation = state.conversations.find((item) => item.id === id);
    document.getElementById("conversation-context").textContent = conversation
      ? `${conversation.whatsappNumber} · ${conversationStateLabel[conversation.pendingAction] || conversation.pendingAction}`
      : "Conversa selecionada";
    const thread = document.getElementById("message-thread");
    const input = document.getElementById("manual-message-text");
    if (switched || !preserve) {
      state.loadedConversationId = null;
      document.getElementById("conversation-actions").classList.add("hidden");
      document.getElementById("manual-message-form").classList.add("hidden");
      thread.className = "message-thread empty-state";
      thread.textContent = "Carregando conversa...";
      input.value = state.drafts.get(id) || "";
    }
    const messages = await api(
      `/admin/api/conversations/${encodeURIComponent(id)}/messages?limit=100`,
      { requestKey: "conversation-detail" },
    );
    if (state.selectedConversationId !== id) return;
    state.loadedConversationId = id;
    document.getElementById("conversation-actions").classList.remove("hidden");
    document.getElementById("manual-message-form").classList.remove("hidden");
    const nearBottom =
      thread.scrollHeight - thread.scrollTop - thread.clientHeight < 70;
    const previousScroll = thread.scrollTop;

    if (!messages.length) {
      thread.className = "message-thread empty-state";
      thread.textContent = "Sem mensagens para exibir.";
      return;
    }

    thread.className = "message-thread";
    thread.innerHTML = messages
      .map((message) => {
        const proofClass = String(message.content)
          .toLowerCase()
          .includes("comprovante")
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
    thread.scrollTop =
      switched || !preserve || nearBottom
        ? thread.scrollHeight
        : previousScroll;
  } catch (error) {
    reportError(error);
    if (
      error.name !== "AbortError" &&
      state.selectedConversationId === id &&
      state.loadedConversationId !== id
    ) {
      document.getElementById("message-thread").textContent =
        "Não foi possível carregar esta conversa. Tente atualizar.";
    }
  }
}

async function sendManualMessage(event) {
  event.preventDefault();
  const id = state.loadedConversationId;
  if (!id || id !== state.selectedConversationId) {
    showToast("Selecione uma conversa primeiro.");
    return;
  }

  const input = document.getElementById("manual-message-text");
  const text = input.value.trim();
  if (!text) {
    showToast("Digite uma mensagem para enviar.");
    return;
  }

  await runAction("send-message", ["send-message-button"], async () => {
    await api(`/admin/api/conversations/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      body: { text },
    });
    if ((state.drafts.get(id) || "").trim() === text) state.drafts.delete(id);
    if (state.selectedConversationId === id) {
      input.value = state.drafts.get(id) || "";
      await selectConversation(id, true);
    }
    showToast("Mensagem enviada pelo WhatsApp.");
  });
}

async function resetSelectedConversation() {
  const id = state.loadedConversationId;
  if (!id) return;
  await runAction(
    "conversation-action",
    ["reset-conversation-button", "close-conversation-button"],
    async () => {
      if (
        !(await askConfirmation(
          "Reiniciar atendimento?",
          "O estado e o carrinho desta conversa serão reiniciados. O histórico será mantido.",
        ))
      )
        return;
      await api(`/admin/api/conversations/${encodeURIComponent(id)}/reset`, {
        method: "POST",
      });
      await loadConversations();
      showToast("Conversa reiniciada.");
    },
  );
}

async function closeSelectedConversation() {
  const id = state.loadedConversationId;
  if (!id) return;
  await runAction(
    "conversation-action",
    ["reset-conversation-button", "close-conversation-button"],
    async () => {
      if (
        !(await askConfirmation(
          "Encerrar atendimento?",
          "Esta conversa será marcada como encerrada.",
        ))
      )
        return;
      await api(`/admin/api/conversations/${encodeURIComponent(id)}/close`, {
        method: "POST",
      });
      if (state.selectedConversationId === id) {
        state.selectedConversationId = null;
        state.loadedConversationId = null;
        document.getElementById("message-thread").className =
          "message-thread empty-state";
        document.getElementById("message-thread").textContent =
          "Conversa encerrada.";
        document.getElementById("manual-message-form").classList.add("hidden");
        document.getElementById("conversation-actions").classList.add("hidden");
        document.getElementById("conversation-context").textContent =
          "Selecione uma conversa";
      }
      await loadConversations();
      showToast("Conversa encerrada.");
    },
  );
}

function renderFilteredOrders() {
  const search = normalizeSearch(document.getElementById("order-search").value);
  const orderStatus = document.getElementById("order-status-filter").value;
  const paymentStatus = document.getElementById("payment-status-filter").value;
  const filtered = state.orders.filter((order) => {
    const searchable = [
      order.id,
      order.customer?.name,
      order.customer?.whatsappNumber,
      ...(order.items || []).flatMap((item) => [
        item.name,
        item.brand,
        item.presentation,
      ]),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return (
      (!search || normalizeSearch(searchable).includes(search)) &&
      (!orderStatus || order.status === orderStatus) &&
      (!paymentStatus || order.payment?.status === paymentStatus)
    );
  });

  document.getElementById("orders-result-count").textContent =
    `${filtered.length} pedido(s)`;
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
        const isPending =
          order.payment?.status === "PENDING" &&
          ["CONFIRMED", "PENDING_PAYMENT_MANUAL"].includes(order.status);
        return `
          <div class="table-row selectable-row ${state.selectedOrderId === order.id ? "active" : ""}" data-order-id="${escapeHtml(order.id)}" role="button" tabindex="0">
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
    target
      .querySelectorAll("[data-table-confirm-payment-id]")
      .forEach((button) => {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          const order = orders.find(
            (item) => item.id === button.dataset.tableConfirmPaymentId,
          );
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
    .map(
      (order) => `
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
    `,
    )
    .join("");
}

async function selectOrder(id, preserve = false) {
  try {
    const switched = state.selectedOrderId !== id;
    state.selectedOrderId = id;
    document.querySelectorAll("[data-order-id]").forEach((item) => {
      item.classList.toggle("active", item.dataset.orderId === id);
    });

    const target = document.getElementById("order-detail");
    const statusSelect = document.getElementById("order-status-select");
    if (switched || !preserve) {
      target.className = "empty-state";
      target.textContent = "Carregando pedido...";
      statusSelect.classList.add("hidden");
    }
    const order = await api(`/admin/api/orders/${encodeURIComponent(id)}`, {
      requestKey: "order-detail",
    });
    if (state.selectedOrderId !== id) return;

    if (!order) {
      target.className = "empty-state";
      target.textContent = "Pedido não encontrado.";
      statusSelect.classList.add("hidden");
      return;
    }

    const pendingPayment = ["CONFIRMED", "PENDING_PAYMENT_MANUAL"].includes(
      order.status,
    )
      ? order.payments.find((payment) => payment.status === "PENDING")
      : null;
    const paidPayment = order.payments.find(
      (payment) => payment.status === "PAID",
    );
    statusSelect.classList.remove("hidden");
    statusSelect.value = order.status;
    statusSelect.dataset.currentStatus = order.status;
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
      ${order.conversationId ? '<button id="order-open-conversation" class="link-button" type="button">Abrir conversa</button>' : ""}
    </div>
    <div class="detail-block">
      <h3>Itens</h3>
      ${renderOrderItems(order.items)}
    </div>
    <div class="detail-block">
      <h3>Entrega</h3>
      ${renderAddress(order.notes?.address, order.notes)}
    </div>
    <div class="detail-block">
      <h3>Pagamentos</h3>
      ${renderPaymentHistory(order.payments)}
    </div>
  `;

    document
      .getElementById("detail-confirm-payment")
      ?.addEventListener("click", () =>
        openConfirmPayment({
          ...order,
          payment: pendingPayment,
        }),
      );
    document
      .getElementById("order-open-conversation")
      ?.addEventListener("click", () => {
        setSection("conversations");
        selectConversation(order.conversationId);
      });
  } catch (error) {
    reportError(error);
    if (error.name !== "AbortError" && state.selectedOrderId === id) {
      document.getElementById("order-status-select").classList.add("hidden");
      document.getElementById("order-detail").textContent =
        "Não foi possível carregar o pedido. Tente atualizar.";
    }
  }
}

async function updateSelectedOrderStatus() {
  const id = state.selectedOrderId;
  if (!id) return;
  const select = document.getElementById("order-status-select");
  const status = select.value;
  if (status === "PAID") {
    showToast(
      "Use o botão “Confirmar que compensou” para registrar o pagamento.",
    );
    return;
  }

  const previous = select.dataset.currentStatus;
  await runAction("order-status", ["order-status-select"], async () => {
    if (
      !(await askConfirmation(
        "Alterar status do pedido?",
        `Pedido ${shortId(id)}: ${orderStatusLabel[previous] || previous} → ${orderStatusLabel[status] || status}.`,
      ))
    )
      return;
    await api(`/admin/api/orders/${encodeURIComponent(id)}/status`, {
      method: "PATCH",
      body: { status },
    });
    await loadOrders();
    showToast("Status do pedido atualizado.");
  });
  if (state.selectedOrderId === id) select.value = select.dataset.currentStatus;
}

function openConfirmPayment(order) {
  state.pendingConfirmationOrder = order;
  const customer =
    order.customer?.name ||
    order.customer?.whatsappNumber ||
    "Cliente WhatsApp";
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
  if (!order || state.actions.has("confirm-payment")) return;
  state.actions.add("confirm-payment");

  const button = document.getElementById("confirm-payment-submit");
  button.disabled = true;
  button.textContent = "Confirmando...";

  try {
    const result = await api(`/admin/api/orders/${order.id}/confirm-payment`, {
      method: "POST",
    });
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
    state.actions.delete("confirm-payment");
    button.disabled = false;
    button.textContent = "Sim, compensou";
  }
}

function renderOrderItemPreview(items) {
  if (!Array.isArray(items) || items.length === 0) return "Sem itens no resumo";
  return items
    .slice(0, 2)
    .map(
      (item) =>
        `${Number(item.quantity) || 1}x ${item.name || item.description || "Item"}`,
    )
    .join(", ");
}

function renderOrderItems(items) {
  if (!Array.isArray(items) || !items.length) {
    return '<p class="muted">Sem itens registrados no pedido.</p>';
  }

  return items
    .map(
      (item, index) => `
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
    `,
    )
    .join("");
}

function renderPaymentHistory(payments) {
  if (!payments.length) return '<p class="muted">Sem pagamento registrado.</p>';
  return payments
    .map(
      (payment) => `
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
    `,
    )
    .join("");
}

function renderAddress(address, notes = {}) {
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
      ${address.complement || notes?.addressComplement ? `<span>${escapeHtml(address.complement || notes.addressComplement)}</span>` : ""}
      ${notes?.addressReference ? `<span>Referência: ${escapeHtml(notes.addressReference)}</span>` : ""}
    </div>
  `;
}

function renderProviders(data) {
  const providers = [
    ["Banco de dados", data.database.configured, "Uso sob demanda"],
    [
      "WhatsApp",
      data.whatsapp.configured,
      `Cloud API ${data.whatsapp.apiVersion}`,
    ],
    [
      "Preço Popular",
      Boolean(data.precoPopular?.enabled),
      data.precoPopular?.enabled
        ? "Fonte principal. Preço integral do catálogo."
        : "Desativado",
    ],
    ...Object.entries(data.medicines?.backups || {}).map(([name, provider]) => [
      name === "pharmadb" ? "PharmaDB" : "BulAPI",
      Boolean(provider.enabled && provider.configured),
      !provider.enabled ? "Reserva desativada" : !provider.configured ? "Chave ausente" :
        name === "pharmadb" ? `Reserva: PF ou ${Math.round(provider.pmcMultiplier * 100)}% do PMC. Conectividade não verificada.` :
          "Reserva: maior PF da apresentação. Conectividade não verificada.",
    ]),
    [
      "Pix direto",
      data.payments.directPixConfigured,
      "Valor individual por pedido; conferência manual",
    ],
    [
      "Painel",
      data.admin.protected,
      data.admin.protected ? "Protegido" : "ADMIN_TOKEN ausente",
    ],
  ];

  document.getElementById("providers-grid").innerHTML = providers
    .map(
      ([name, configured, detail]) => `
      <div class="provider-card">
        <div class="item-title">
          <h3>${escapeHtml(name)}</h3>
          ${statusBadge(configured ? "Configurado" : "Atenção", configured ? "ok" : "warn")}
        </div>
        <p class="muted">${escapeHtml(String(detail))}</p>
        <div class="item-meta"><span>Configuração local, sem teste de conexão</span></div>
      </div>
    `,
    )
    .join("");
}

function renderErrorSummary(summary) {
  const items = [
    [
      "Mensagens com falha",
      summary.failedMessages,
      "Envios que precisam de revisão",
      summary.failedMessages ? "critical" : "positive",
    ],
    [
      "Pagamentos com falha",
      summary.failedPayments,
      "Registros com erro",
      summary.failedPayments ? "critical" : "positive",
    ],
    [
      "Pix pendentes",
      summary.pendingPayments,
      "Fila de compensação",
      summary.pendingPayments ? "attention" : "positive",
    ],
    ["Pedidos cancelados", summary.cancelledOrders, "Histórico total", ""],
  ];
  document.getElementById("errors-summary").innerHTML = items
    .map(([label, value, helper, tone]) =>
      metricCard(label, value, helper, tone),
    )
    .join("");
}

function renderFailedMessages(messages) {
  const target = document.getElementById("failed-messages");
  target.innerHTML = messages.length
    ? messages
        .map(
          (item) => `
          <div class="list-item">
            <div class="item-title"><span>${escapeHtml(item.customer)}</span>${statusBadge("Falhou", "error")}</div>
            <p class="muted">${escapeHtml(item.content)}</p>
            <div class="item-meta"><span>${formatDate(item.createdAt)}</span></div>
          </div>
        `,
        )
        .join("")
    : empty("Nenhuma mensagem com falha.");
}

function renderFailedPayments(payments) {
  const target = document.getElementById("failed-payments");
  target.innerHTML = payments.length
    ? payments
        .map(
          (item) => `
          <div class="list-item">
            <div class="item-title"><span>${escapeHtml(item.customer)}</span>${statusBadge("Falhou", "error")}</div>
            <div class="item-meta">
              <span>${formatMoney(item.amountCents)}</span>
              <span>${escapeHtml(item.provider || "sem provedor")}</span>
              <span>${formatDate(item.createdAt)}</span>
            </div>
          </div>
        `,
        )
        .join("")
    : empty("Nenhum pagamento com falha.");
}

async function api(path, options = {}) {
  const version = state.sessionVersion;
  const method = options.method || "GET";
  const key =
    options.requestKey ||
    (method === "GET" ? path.split("?")[0] : Symbol(path));
  state.requests.get(key)?.abort();
  const controller = new AbortController();
  state.requests.set(key, controller);
  const timeout = window.setTimeout(
    () => controller.abort("timeout"),
    method === "GET" ? 20000 : 45000,
  );
  try {
    const headers = {
      ...(state.token ? { "x-admin-token": state.token } : {}),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    };
    const response = await fetch(path, {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
      cache: "no-store",
    });

    if (response.status === 403 && options.allowForbidden) {
      return { protected: true, authenticated: false };
    }

    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("application/json")
      ? await response.json()
      : await response.text();
    if (version !== state.sessionVersion || controller.signal.aborted)
      throw new DOMException("Solicitação substituída", "AbortError");

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        endSession();
        throw new Error("Acesso expirado ou não autorizado. Entre novamente.");
      }
      const message = Array.isArray(body?.message)
        ? body.message.join(" ")
        : body?.message ||
          body?.error ||
          `Falha ${response.status} ao carregar ${path}`;
      throw new Error(message);
    }

    return body;
  } catch (error) {
    if (controller.signal.reason === "timeout") {
      throw new Error(
        method === "GET"
          ? "O servidor demorou para responder. Tente atualizar."
          : "O servidor demorou para confirmar a ação. Confira o histórico antes de tentar novamente.",
      );
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
    if (state.requests.get(key) === controller) state.requests.delete(key);
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  if (!document.getElementById("auto-refresh").checked) return;
  state.refreshTimer = window.setInterval(() => {
    if (
      !document.hidden &&
      !document.querySelector("dialog[open]") &&
      !state.actions.size
    )
      refresh();
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

function metricCard(label, value, helper = "", tone = "", section = "") {
  const tag = section ? "button" : "div";
  return `
    <${tag} class="metric-card ${tone}" ${section ? `type="button" data-metric-section="${section}"` : ""}>
      <span class="metric-label">${escapeHtml(label)}</span>
      <strong>${escapeHtml(String(value ?? 0))}</strong>
      ${helper ? `<small>${escapeHtml(helper)}</small>` : ""}
    </${tag}>
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
  return String(id || "")
    .slice(-8)
    .toUpperCase();
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
  document.querySelector(".app-shell").inert = true;
  document.getElementById("auth-modal").classList.remove("hidden");
}

function hideAuth() {
  document.querySelector(".app-shell").inert = false;
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
    timer = window.setTimeout(() => handled(callback)(...args), wait);
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

function normalizeSearch(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function renderFilteredPayments() {
  const search = normalizeSearch(
    document.getElementById("payment-search").value,
  );
  const proof = document.getElementById("proof-filter").value;
  const wait = Number(document.getElementById("waiting-filter").value);
  const filtered = state.pendingPayments.filter((order) => {
    const text = normalizeSearch(
      [
        order.id,
        order.customer?.name,
        order.customer?.whatsappNumber,
        renderOrderItemPreview(order.items),
      ].join(" "),
    );
    return (
      (!search || text.includes(search)) &&
      (!wait || order.waitingMinutes >= wait) &&
      (!proof ||
        (proof === "received" ? order.proofReceived : !order.proofReceived))
    );
  });
  const total = filtered.reduce((sum, order) => sum + order.totalCents, 0);
  document.getElementById("pending-payments-summary").textContent =
    `${filtered.length} de ${state.pendingPayments.length} na lista · ${formatMoney(total)}`;
  renderPendingPayments(
    document.getElementById("pending-payments-list"),
    filtered,
    false,
  );
}

function providerName(value) {
  return (
    {
      preco_popular: "Preço Popular",
      pharmadb: "PharmaDB",
      bulapi: "BulAPI",
      cosmos: "Cosmos",
      whatsapp: "WhatsApp",
    }[value] || value
  );
}

function renderProviderLogs() {
  const search = normalizeSearch(
    document.getElementById("provider-log-search").value,
  );
  const provider = document.getElementById("provider-log-provider").value;
  const outcome = document.getElementById("provider-log-outcome").value;
  const isFailure = (item) =>
    item.statusCode >= 400 ||
    ["ERROR", "FAILED", "TIMEOUT"].includes(item.outcome);
  const logs = state.providerLogs.filter(
    (item) =>
      (!provider || item.provider === provider) &&
      (!outcome ||
        (outcome === "errors" ? isFailure(item) : item.outcome === outcome)) &&
      (!search ||
        normalizeSearch(
          [item.query, item.operation, item.traceId].join(" "),
        ).includes(search)),
  );
  document.getElementById("provider-log-count").textContent =
    `${logs.length} de ${state.providerLogs.length} registros recentes`;
  const opened = new Set(
    [...document.querySelectorAll(".request-log[open]")].map(
      (item) => item.dataset.logId,
    ),
  );
  document.getElementById("provider-logs").innerHTML = logs.length
    ? logs
        .map(
          (item) => `
    <details class="request-log" data-log-id="${escapeHtml(item.id)}" ${opened.has(item.id) ? "open" : ""}>
      <summary><span class="log-provider">${escapeHtml(providerName(item.provider))}</span><span class="log-query">${escapeHtml(item.query || item.operation)}</span>
        ${statusBadge(isFailure(item) ? "Falha" : item.outcome === "EMPTY" ? "Sem resultados" : item.outcome === "SUCCESS" ? "Sucesso" : item.outcome === "FALLBACK" ? "Alternativa" : item.outcome, isFailure(item) ? "error" : item.outcome === "SUCCESS" ? "ok" : "warn")}
        <span class="muted">${item.durationMs == null ? "" : `${item.durationMs} ms`} · ${formatDate(item.createdAt)}</span></summary>
      <dl class="log-details"><div><dt>HTTP</dt><dd>${escapeHtml(item.statusCode ?? "Sem resposta HTTP")}</dd></div><div><dt>Encontrados / após filtro</dt><dd>${escapeHtml(item.resultsFound ?? "—")} / ${escapeHtml(item.resultsAfterFilter ?? "—")}</dd></div>
        <div><dt>Operação</dt><dd>${escapeHtml(item.operation)}</dd></div><div><dt>Rastreio</dt><dd>${escapeHtml(item.traceId || "Não registrado")}</dd></div>
        ${item.failureReason ? `<div class="full-span"><dt>Motivo registrado</dt><dd>${escapeHtml(item.failureReason)}</dd></div>` : ""}</dl>
    </details>`,
        )
        .join("")
    : empty("Nenhuma chamada encontrada neste recorte.");
}

function setPrioritiesDirty(dirty) {
  state.prioritiesDirty = dirty;
  document.getElementById("priority-save-state").textContent = dirty
    ? "Alterações não salvas"
    : "Sem alterações pendentes";
  document
    .getElementById("priority-save-state")
    .classList.toggle("danger-text", dirty);
  document.getElementById("discard-priorities-button").disabled = !dirty;
}

function reportError(error) {
  if (error.name !== "AbortError")
    showToast(error.message || "Não foi possível concluir a ação.");
}

function handled(callback) {
  return (...args) =>
    Promise.resolve()
      .then(() => callback(...args))
      .catch(reportError);
}

async function runAction(key, controls, callback) {
  if (state.actions.has(key)) return;
  state.actions.add(key);
  controls.forEach((id) => {
    document.getElementById(id).disabled = true;
  });
  try {
    await callback();
  } catch (error) {
    reportError(error);
  } finally {
    state.actions.delete(key);
    controls.forEach((id) => {
      document.getElementById(id).disabled = false;
    });
  }
}

function askConfirmation(title, description) {
  const dialog = document.getElementById("action-dialog");
  if (dialog.open) return Promise.resolve(false);
  document.getElementById("action-dialog-title").textContent = title;
  document.getElementById("action-dialog-description").textContent =
    description;
  dialog.returnValue = "cancel";
  dialog.showModal();
  return new Promise((resolve) =>
    dialog.addEventListener(
      "close",
      () => resolve(dialog.returnValue === "confirm"),
      { once: true },
    ),
  );
}

function endSession() {
  state.sessionVersion += 1;
  state.authenticated = false;
  state.token = "";
  localStorage.removeItem("raia_admin_token");
  state.requests.forEach((controller) => controller.abort());
  state.requests.clear();
  state.drafts.clear();
  state.conversations = [];
  state.orders = [];
  state.pendingPayments = [];
  state.providerLogs = [];
  state.medicinePriorityRules = [];
  state.selectedConversationId = null;
  state.loadedConversationId = null;
  state.selectedOrderId = null;
  state.pendingConfirmationOrder = null;
  state.actions.clear();
  state.refreshing.clear();
  stopAutoRefresh();
  document
    .querySelectorAll("dialog[open]")
    .forEach((dialog) => dialog.close("cancel"));
  document
    .querySelectorAll(
      ".list, .payment-queue, .table, .metrics-grid, #order-detail, #providers-grid, #medicine-priorities-meta, #database-result",
    )
    .forEach((element) => {
      element.innerHTML = "";
    });
  document.getElementById("message-thread").textContent =
    "Selecione uma conversa";
  document.querySelectorAll("textarea, #admin-token").forEach((input) => {
    input.value = "";
  });
  for (const id of [
    "manual-message-form",
    "conversation-actions",
    "order-status-select",
  ])
    document.getElementById(id).classList.add("hidden");
  document.getElementById("conversation-context").textContent =
    "Selecione uma conversa";
  setPrioritiesDirty(false);
  setAuthState("Sessão encerrada");
  showAuth();
}

document.addEventListener("keydown", (event) => {
  if (
    ["Enter", " "].includes(event.key) &&
    event.target.matches('[role="button"][tabindex="0"]')
  ) {
    event.preventDefault();
    event.target.click();
  }
});
