export type ConversationOpeningIntent = "greeting" | "start_order";

export function stripGreetingPrefix(text: string) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(
      /^(?:(?:oi+|ola+|bom\s+dia|boa\s+tarde|boa\s+noite|e\s+ai|hello|hi)\b[\s\p{P}\p{S}]*)+/u,
      "",
    )
    .trim();
}

export function getConversationOpeningIntent(
  text: string,
): ConversationOpeningIntent | null {
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const withoutGreeting = stripGreetingPrefix(normalized);
  const greeted = withoutGreeting !== normalized;
  const body = withoutGreeting
    .replace(
      /^(?:tudo bem|tudo bom|como vai)(?: com voces| com voce)?\b\s*/,
      "",
    )
    .replace(/\b(?:por favor|pfv|obrigado|obrigada)$/, "")
    .trim();

  if (
    !body &&
    (greeted ||
      /^(?:tudo bem|tudo bom|como vai)(?: com voces| com voce)?$/.test(
        normalized,
      ))
  ) {
    return "greeting";
  }

  const request = body
    .replace(
      /^(?:eu\s+)?(?:gostaria|queria|quero|preciso|desejo|posso|poderia|podemos)(?:\s+de)?\s+|^(?:tem como|da para)\s+/,
      "",
    )
    .replace(/\s+(?:aqui|com voces|com voce|pelo whatsapp|pelo zap)$/, "");

  // Match the entire request: a named product, dose or symptom must not be lost.
  const orderOnly =
    /^(?:(?:fazer|realizar|montar|iniciar)\s+)?(?:(?:um|uma|o|a|meu|minha|novo|nova)\s+)*(?:pedido|compra)$/;
  const purchaseOnly =
    /^(?:comprar|(?:comprar\s+|pedir\s+)?(?:(?:um|uma|uns|alguns)\s+)?(?:remedio|remedios|medicamento|medicamentos|produto|produtos))$/;
  return orderOnly.test(request) || purchaseOnly.test(request)
    ? "start_order"
    : null;
}
