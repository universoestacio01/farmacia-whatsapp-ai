export const PIX_PROVIDER = Symbol("PIX_PROVIDER");

export interface CreatePixPaymentInput {
  orderId: string;
  amountCents: number;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  customerDocument?: string;
  description?: string;
  items?: Array<{
    id: string;
    name: string;
    quantity: number;
    unitPrice: number;
  }>;
  callbackUrl?: string;
}

export interface PixPaymentResult {
  provider: string;
  providerPaymentId?: string;
  providerTransactionId?: string;
  pixPayload?: string;
  pixCopyPaste?: string;
  pixQrCode?: string;
  paymentUrl?: string;
  expiresAt?: Date;
  rawResponse?: unknown;
}

export interface PixProvider {
  createPayment(input: CreatePixPaymentInput): Promise<PixPaymentResult>;
}
