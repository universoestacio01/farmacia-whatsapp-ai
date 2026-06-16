export const PIX_PROVIDER = Symbol("PIX_PROVIDER");

export interface CreatePixPaymentInput {
  orderId: string;
  amountCents: number;
  customerName?: string;
  description?: string;
}

export interface PixPaymentResult {
  provider: string;
  providerPaymentId?: string;
  pixPayload?: string;
  expiresAt?: Date;
}

export interface PixProvider {
  createPayment(input: CreatePixPaymentInput): Promise<PixPaymentResult>;
}
