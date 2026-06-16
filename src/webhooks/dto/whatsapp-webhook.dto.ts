export interface WhatsappWebhookPayload {
  object?: string;
  entry?: WhatsappEntry[];
}

export interface WhatsappEntry {
  id?: string;
  changes?: WhatsappChange[];
}

export interface WhatsappChange {
  field?: string;
  value?: WhatsappChangeValue;
}

export interface WhatsappChangeValue {
  messaging_product?: string;
  metadata?: {
    display_phone_number?: string;
    phone_number_id?: string;
  };
  contacts?: Array<{
    wa_id?: string;
    profile?: {
      name?: string;
    };
  }>;
  messages?: WhatsappIncomingMessage[];
  statuses?: Array<Record<string, unknown>>;
}

export interface WhatsappIncomingMessage {
  from: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: {
    body?: string;
  };
}
