function bindSalesActions() {
  document.getElementById("sales-period").addEventListener(
    "change",
    handled(async () => {
      state.salesDay = "";
      state.salesVisible = 50;
      await loadSales();
    }),
  );
  for (const id of ["sales-search", "sales-status", "sales-proof"]) {
    document.getElementById(id).addEventListener("input", () => {
      state.salesVisible = 50;
      renderSales();
    });
  }
  document.getElementById("sales-clear-day").addEventListener("click", () => {
    state.salesDay = "";
    state.salesVisible = 50;
    renderSales();
  });
  document.getElementById("sales-more").addEventListener("click", () => {
    state.salesVisible += 50;
    renderSales();
  });
  document
    .getElementById("sales-export")
    .addEventListener("click", exportSales);
}

async function loadSales() {
  const period = document.getElementById("sales-period").value;
  const previousRange = state.sales
    ? `${state.sales.from}/${state.sales.to}`
    : "";
  document.getElementById("sales-feedback").textContent =
    "Atualizando vendas...";
  document.getElementById("sales-export").disabled = true;
  try {
    const data = await api(
      `/admin/api/sales?period=${encodeURIComponent(period)}`,
      { requestKey: "sales" },
    );
    state.sales = data;
    document.getElementById("sales-feedback").textContent = "";
    document.getElementById("sales-export").disabled = false;
    renderSales();
    if (previousRange !== `${data.from}/${data.to}`) {
      const chart = document.getElementById("sales-chart");
      chart.scrollLeft = chart.scrollWidth;
    }
  } catch (error) {
    if (error.name !== "AbortError") {
      state.sales = null;
      renderSales();
      document.getElementById("sales-feedback").textContent =
        "Não foi possível atualizar as vendas. Tente novamente.";
    }
    throw error;
  }
}

function filteredSales() {
  const search = document
    .getElementById("sales-search")
    .value.trim()
    .toLocaleLowerCase("pt-BR");
  const status = document.getElementById("sales-status").value;
  const proof = document.getElementById("sales-proof").value;
  return (state.sales?.rows || []).filter((row) => {
    if (status && row.saleStatus !== status) return false;
    if (proof === "received" && !row.proofReceivedAt) return false;
    if (proof === "missing" && row.proofReceivedAt) return false;
    return (
      !search ||
      [
        row.id,
        row.customer.name,
        row.customer.whatsappNumber,
        ...row.items.map((item) => item.name),
      ]
        .join(" ")
        .toLocaleLowerCase("pt-BR")
        .includes(search)
    );
  });
}

function salesDate(day) {
  return day.split("-").reverse().join("/");
}

function renderSales() {
  const data = state.sales;
  if (!data) {
    for (const id of [
      "sales-metrics",
      "sales-chart",
      "sales-list",
      "sales-range",
      "sales-list-summary",
    ])
      document.getElementById(id).textContent = "";
    document.getElementById("sales-more").classList.add("hidden");
    return;
  }
  const rows = filteredSales();
  const total = rows.reduce((sum, row) => sum + row.totalCents, 0);
  const settled = rows.filter((row) => row.saleStatus === "SETTLED");
  const paid = settled.reduce((sum, row) => sum + row.totalCents, 0);
  const metrics = [
    ["Vendas no período", formatMoney(total), `${rows.length} pedido(s)`, ""],
    [
      "Compensado",
      formatMoney(paid),
      `${settled.length} pedido(s) confirmado(s)`,
      "SETTLED",
    ],
    [
      "Aguardando compensação",
      formatMoney(total - paid),
      `${rows.length - settled.length} pedido(s) com comprovante`,
      "AWAITING_SETTLEMENT",
    ],
    [
      "Ticket médio",
      formatMoney(rows.length ? Math.round(total / rows.length) : 0),
      "Por pedido vendido",
      "",
    ],
  ];
  document.getElementById("sales-metrics").innerHTML = metrics
    .map(
      ([label, value, detail, status]) =>
        `<button type="button" class="sales-metric" data-sale-status="${status}"><span>${label}</span><strong>${value}</strong><small>${detail}</small></button>`,
    )
    .join("");
  document.querySelectorAll("[data-sale-status]").forEach((button) =>
    button.addEventListener("click", () => {
      document.getElementById("sales-status").value = button.dataset.saleStatus;
      state.salesVisible = 50;
      renderSales();
    }),
  );
  document.getElementById("sales-range").textContent =
    `${salesDate(data.from)} a ${salesDate(data.to)} · Data do pedido · São Paulo`;
  const byDay = new Map(
    data.days.map((day) => [
      day.day,
      { day: day.day, count: 0, settled: 0, pending: 0 },
    ]),
  );
  rows.forEach((row) => {
    const day = byDay.get(row.day);
    if (!day) return;
    day.count++;
    day[row.saleStatus === "SETTLED" ? "settled" : "pending"] += row.totalCents;
  });
  const days = [...byDay.values()];
  const maximum = Math.max(1, ...days.map((day) => day.settled + day.pending));
  const chart = document.getElementById("sales-chart");
  const scroll = chart.scrollLeft;
  chart.innerHTML = `<div class="sales-chart-plot">${days
    .map((day) => {
      const label = `${salesDate(day.day)}: ${day.count} venda(s), ${formatMoney(day.settled + day.pending)}. Compensado ${formatMoney(day.settled)}; a conferir ${formatMoney(day.pending)}.`;
      return `<button type="button" class="sales-day ${state.salesDay === day.day ? "selected" : ""}" data-sales-day="${day.day}" aria-label="${label}" title="${label}" aria-pressed="${state.salesDay === day.day}">
      <span class="sales-day-count">${day.count || ""}</span><span class="sales-bar-track"><span class="sales-bar pending" style="height:${(day.pending / maximum) * 100}%"></span><span class="sales-bar settled" style="height:${(day.settled / maximum) * 100}%"></span></span><span class="sales-day-label">${salesDate(day.day).slice(0, 5)}</span></button>`;
    })
    .join("")}</div>`;
  chart.scrollLeft = scroll;
  chart.querySelectorAll("[data-sales-day]").forEach((button) =>
    button.addEventListener("click", () => {
      const day = button.dataset.salesDay;
      state.salesDay = state.salesDay === day ? "" : day;
      state.salesVisible = 50;
      renderSales();
      chart
        .querySelector(`[data-sales-day="${day}"]`)
        ?.focus({ preventScroll: true });
    }),
  );
  const list = rows.filter(
    (row) => !state.salesDay || row.day === state.salesDay,
  );
  const visible = list.slice(0, state.salesVisible);
  const selectedTotal = list.reduce((sum, row) => sum + row.totalCents, 0);
  document
    .getElementById("sales-clear-day")
    .classList.toggle("hidden", !state.salesDay);
  document.getElementById("sales-list-summary").textContent =
    `${visible.length} de ${list.length} venda(s) · ${formatMoney(selectedTotal)}${state.salesDay ? ` · ${salesDate(state.salesDay)}` : " · Mais recentes primeiro"}`;
  document.getElementById("sales-list").innerHTML = visible.length
    ? visible
        .map(
          (row) => `<div class="sales-row">
    <div><strong>${escapeHtml(row.customer.name || "Cliente WhatsApp")}</strong><p>${escapeHtml(row.customer.whatsappNumber)}</p><p>${escapeHtml(row.items.map((item) => `${item.quantity}x ${item.name}`).join(" · "))}</p><small>${escapeHtml(row.id)}</small></div>
    <div class="sales-row-value"><strong>${formatMoney(row.totalCents)}</strong><p>${salesDate(row.day)}</p>${statusBadge(row.saleStatus === "SETTLED" ? "Compensada" : "Aguardando compensação", row.saleStatus === "SETTLED" ? "ok" : "warn")}<p class="muted">${row.proofReceivedAt ? "Comprovante recebido" : "Sem comprovante anexado"}</p></div>
    <button class="link-button" data-sale-order="${escapeHtml(row.id)}" type="button">Ver pedido</button></div>`,
        )
        .join("")
    : empty("Nenhuma venda neste filtro.");
  document.querySelectorAll("[data-sale-order]").forEach((button) =>
    button.addEventListener(
      "click",
      handled(async () => {
        setSection("orders");
        await selectOrder(button.dataset.saleOrder);
      }),
    ),
  );
  document
    .getElementById("sales-more")
    .classList.toggle("hidden", visible.length >= list.length);
}

function exportSales() {
  if (!state.sales) return;
  const rows = filteredSales().filter(
    (row) => !state.salesDay || row.day === state.salesDay,
  );
  const cells = [
    [
      "Pedido",
      "Data do pedido (São Paulo)",
      "Cliente",
      "Telefone",
      "Valor (R$)",
      "Situação",
      "Comprovante recebido",
    ],
  ];
  rows.forEach((row) =>
    cells.push([
      row.id,
      row.day,
      row.customer.name || "",
      row.customer.whatsappNumber,
      (row.totalCents / 100).toFixed(2).replace(".", ","),
      row.saleStatus === "SETTLED" ? "Compensada" : "Aguardando compensação",
      row.proofReceivedAt ? "Sim" : "Não",
    ]),
  );
  const csv = cells
    .map((row) =>
      row
        .map((value) => {
          let cell = String(value);
          if (/^[\s]*[=+@-]/.test(cell) || /^[\t\r\n]/.test(cell))
            cell = `'${cell}`;
          return `"${cell.replace(/"/g, '""')}"`;
        })
        .join(";"),
    )
    .join("\r\n");
  const url = URL.createObjectURL(
    new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `vendas-${state.sales.from}-${state.sales.to}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
