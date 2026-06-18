export type PaymentProvider = "sigilopay" | "manual";

export type NormalizedPaymentStatus =
  | "pending"
  | "paid"
  | "expired"
  | "cancelled"
  | "failed";

export interface PaymentRecord {
  id: string;
  orderId: string;
  provider: PaymentProvider;
  providerTransactionId?: string;
  status: NormalizedPaymentStatus;
  amount: number;
  pixCopyPaste?: string;
  pixQrCode?: string;
  paymentUrl?: string;
  expiresAt?: Date;
  rawResponse?: unknown;
}

export interface PaymentCustomer {
  id?: string;
  name?: string;
  email?: string;
  phone: string;
  document?: string;
}

export interface PaymentProductItem {
  id: string;
  name: string;
  quantity: number;
  unitPrice: number;
  physical?: boolean;
}

export interface CreatePaymentForOrderInput {
  orderId: string;
  amountCents: number;
  customer: PaymentCustomer;
  items: PaymentProductItem[];
  callbackUrl?: string;
}

export interface CreatePaymentResult {
  provider: PaymentProvider;
  status: NormalizedPaymentStatus;
  providerTransactionId?: string;
  pixCopyPaste?: string;
  pixQrCode?: string;
  paymentUrl?: string;
  expiresAt?: Date;
  rawResponse?: unknown;
  manualFallback: boolean;
}

export interface SigiloPayWebhookEvent {
  event?: string;
  token?: string;
  transaction?: {
    id?: string;
    status?: string;
    amount?: number;
    chargeAmount?: number;
    paymentMethod?: string;
    payedAt?: string | null;
    pixInformation?: {
      qrCode?: string;
      image?: string;
      base64?: string;
      endToEndId?: string | null;
    } | null;
  };
  orderItems?: unknown[];
  [key: string]: unknown;
}
