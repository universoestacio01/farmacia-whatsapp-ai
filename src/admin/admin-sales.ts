export interface ReceiptOrder {
  id: string;
  conversationId: string | null;
  createdAt: Date;
  payments: { createdAt: Date }[];
}

export interface ReceiptConversation {
  id: string;
  messages: { createdAt: Date }[];
}

// A receipt belongs to the most recent checkout, never every order in a chat.
export function associateReceipts(
  orders: ReceiptOrder[],
  conversations: ReceiptConversation[],
) {
  const result = new Map<string, Date>();
  const byConversation = new Map<string, ReceiptOrder[]>();
  for (const order of orders) {
    if (!order.conversationId) continue;
    const group = byConversation.get(order.conversationId) || [];
    group.push(order);
    byConversation.set(order.conversationId, group);
  }
  for (const conversation of conversations) {
    const group = (byConversation.get(conversation.id) || []).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
    for (const receipt of conversation.messages) {
      const candidates = group.filter(
        (order) => order.createdAt <= receipt.createdAt,
      );
      const order = candidates[0];
      if (
        !order ||
        candidates[1]?.createdAt.getTime() === order.createdAt.getTime()
      )
        continue;
      if (
        !order.payments.some(
          (payment) => payment.createdAt <= receipt.createdAt,
        )
      )
        continue;
      const previous = result.get(order.id);
      if (!previous || receipt.createdAt < previous)
        result.set(order.id, receipt.createdAt);
    }
  }
  return result;
}

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export function salesDay(date: Date) {
  return dayFormatter.format(date);
}

export interface SalesOrder extends ReceiptOrder {
  status: string;
  totalCents: number;
  customer: { name: string | null; whatsappNumber: string };
  items: { name: string; quantity: number }[];
  payments: { createdAt: Date; status: string }[];
}

export function buildSalesReport(
  orders: SalesOrder[],
  receipts: Map<string, Date>,
  from: string,
  to: string,
) {
  const rows = orders
    .filter((order) => !["CANCELLED", "DRAFT"].includes(order.status))
    .filter(
      (order) =>
        receipts.has(order.id) ||
        order.payments.some((payment) => payment.status === "PAID"),
    )
    .map((order) => ({
      id: order.id,
      createdAt: order.createdAt,
      day: salesDay(order.createdAt),
      totalCents: order.totalCents,
      customer: order.customer,
      items: order.items,
      proofReceivedAt: receipts.get(order.id) || null,
      saleStatus: order.payments.some((payment) => payment.status === "PAID")
        ? "SETTLED"
        : "AWAITING_SETTLEMENT",
    }))
    .filter((row) => row.day >= from && row.day <= to)
    .sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() ||
        b.id.localeCompare(a.id),
    );
  const days = [] as {
    day: string;
    count: number;
    totalCents: number;
    settledCents: number;
    pendingCents: number;
  }[];
  for (
    let date = new Date(`${from}T12:00:00Z`);
    date.toISOString().slice(0, 10) <= to;
    date.setUTCDate(date.getUTCDate() + 1)
  ) {
    days.push({
      day: date.toISOString().slice(0, 10),
      count: 0,
      totalCents: 0,
      settledCents: 0,
      pendingCents: 0,
    });
  }
  const byDay = new Map(days.map((day) => [day.day, day]));
  let settledCents = 0;
  let settledCount = 0;
  for (const row of rows) {
    const day = byDay.get(row.day)!;
    day.count++;
    day.totalCents += row.totalCents;
    if (row.saleStatus === "SETTLED") {
      day.settledCents += row.totalCents;
      settledCents += row.totalCents;
      settledCount++;
    } else day.pendingCents += row.totalCents;
  }
  const totalCents = rows.reduce((sum, row) => sum + row.totalCents, 0);
  return {
    generatedAt: new Date().toISOString(),
    from,
    to,
    timezone: "America/Sao_Paulo",
    dateBasis: "order_created_at",
    summary: {
      count: rows.length,
      totalCents,
      settledCount,
      settledCents,
      pendingCount: rows.length - settledCount,
      pendingCents: totalCents - settledCents,
      averageCents: rows.length ? Math.round(totalCents / rows.length) : 0,
    },
    days,
    rows,
  };
}
