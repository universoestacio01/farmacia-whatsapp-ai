import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sanitizeEnv } from "../config/env-sanitize";
import {
  CreatePixPaymentInput,
  PixPaymentResult,
  PixProvider,
} from "./pix/pix-provider.interface";
import {
  NormalizedPaymentStatus,
  SigiloPayWebhookEvent,
} from "./payment.types";

interface SigiloPayPixResponse {
  transactionId?: string;
  status?: string;
  fee?: number;
  order?: {
    id?: string;
    url?: string;
  };
  pix?: {
    code?: string;
    base64?: string;
    image?: string;
  };
  details?: string;
  errorDescription?: string;
  message?: string;
}

interface SigiloPayTransactionResponse {
  id?: string;
  clientIdentifier?: string;
  amount?: number;
  chargeAmount?: number;
  status?: string;
  payedAt?: string | null;
  pixInformation?: {
    qrCode?: string;
    image?: string;
    base64?: string;
  } | null;
  [key: string]: unknown;
}

export class SigiloPayError extends Error {
  constructor(
    message: string,
    readonly code: "CONFIG_MISSING" | "API_ERROR" | "TIMEOUT" | "INVALID_RESPONSE",
    readonly statusCode?: number,
    readonly responseData?: unknown,
  ) {
    super(message);
    this.name = "SigiloPayError";
  }
}

@Injectable()
export class SigiloPayService implements PixProvider {
  private readonly logger = new Logger(SigiloPayService.name);

  constructor(private readonly configService: ConfigService) {}

  isEnabled() {
    return (
      this.configService.get<boolean>("SIGILOPAY_ENABLED") === true ||
      sanitizeEnv(process.env.SIGILOPAY_ENABLED).toLowerCase() === "true"
    );
  }

  isConfigured() {
    return Boolean(
      this.getPublicKey() && this.getSecretKey() && this.getBaseUrl(),
    );
  }

  isWebhookConfigured() {
    return Boolean(this.getWebhookToken());
  }

  async createPayment(input: CreatePixPaymentInput): Promise<PixPaymentResult> {
    this.assertReady();

    const amount = this.centsToMoney(input.amountCents);
    const payload = {
      identifier: `order_${input.orderId}`,
      amount,
      client: {
        name: input.customerName || "Cliente WhatsApp",
        email: input.customerEmail || this.defaultCustomerEmail(input.orderId),
        phone: input.customerPhone || "00000000000",
        document: input.customerDocument || "00000000000",
      },
      products: (input.items || []).map((item) => ({
        id: item.id,
        name: item.name,
        quantity: item.quantity,
        price: item.unitPrice,
        physical: true,
      })),
      metadata: {
        provider: "farmacia-whatsapp-ai",
        orderId: input.orderId,
      },
      callbackUrl: input.callbackUrl || this.getCallbackUrl(),
    };

    const response = await this.request<SigiloPayPixResponse>(
      "/gateway/pix/receive",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );

    const pixCode = response.pix?.code;
    const transactionId = response.transactionId;

    if (!transactionId || !pixCode) {
      throw new SigiloPayError(
        "Resposta da SigiloPay sem transactionId ou Pix copia e cola.",
        "INVALID_RESPONSE",
      );
    }

    this.logger.log(
      `SIGILOPAY PIX CREATED: transaction=${transactionId}, pix=${this.maskPix(pixCode)}`,
    );

    return {
      provider: "sigilopay",
      providerPaymentId: transactionId,
      providerTransactionId: transactionId,
      pixPayload: pixCode,
      pixCopyPaste: pixCode,
      pixQrCode: response.pix?.base64 || response.pix?.image,
      paymentUrl: response.order?.url,
      rawResponse: response,
    };
  }

  async getTransaction(
    transactionId: string,
  ): Promise<SigiloPayTransactionResponse | null> {
    if (!transactionId) {
      return null;
    }

    this.assertReady();

    const data = await this.request<
      SigiloPayTransactionResponse | SigiloPayTransactionResponse[]
    >(`/gateway/transactions?id=${encodeURIComponent(transactionId)}`, {
      method: "GET",
    });

    return Array.isArray(data) ? data[0] || null : data;
  }

  validateWebhook(payload: SigiloPayWebhookEvent) {
    const secret = this.getWebhookToken();

    if (!secret) {
      this.logger.warn("SIGILOPAY WEBHOOK TOKEN NOT CONFIGURED");
      return true;
    }

    return payload.token === secret;
  }

  mapStatus(status: string | undefined): NormalizedPaymentStatus {
    const normalized = (status || "").toLowerCase();

    if (
      ["paid", "approved", "completed", "confirmed", "payment_approved"].includes(
        normalized,
      )
    ) {
      return "paid";
    }

    if (["pending", "waiting_payment", "created", "ok"].includes(normalized)) {
      return "pending";
    }

    if (["failed", "refused", "error", "rejected"].includes(normalized)) {
      return "failed";
    }

    if (["cancelled", "canceled"].includes(normalized)) {
      return "cancelled";
    }

    if (normalized === "expired") {
      return "expired";
    }

    return "pending";
  }

  private async request<T>(
    path: string,
    init: RequestInit,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const url = `${this.getBaseUrl()}${path}`;
    const requestBody = this.safeParseJson(init.body);

    try {
      const headers = {
        "Content-Type": "application/json",
        "x-public-key": this.getPublicKey(),
        "x-secret-key": this.getSecretKey(),
        ...(init.headers || {}),
      };

      this.logger.log(
        `SIGILOPAY REQUEST: ${JSON.stringify({
          url,
          endpoint: path,
          method: init.method || "GET",
          headers: this.maskHeaders(headers),
          body: requestBody,
        })}`,
      );

      const response = await fetch(url, {
        ...init,
        headers,
        signal: controller.signal,
      });

      const text = await response.text();
      const data = text ? (this.safeParseJson(text) as T) : ({} as T);

      this.logger.log(
        `SIGILOPAY RESPONSE: ${JSON.stringify({
          url,
          endpoint: path,
          status: response.status,
          headers: this.getResponseHeaders(response.headers),
          data,
        })}`,
      );

      if (!response.ok) {
        this.logger.error(`SIGILOPAY API ERROR STATUS: ${response.status}`);
        throw new SigiloPayError(
          this.getApiErrorMessage(data),
          "API_ERROR",
          response.status,
          data,
        );
      }

      return data;
    } catch (error) {
      if (error instanceof SigiloPayError) {
        this.logger.error(
          `SIGILOPAY ERROR: ${JSON.stringify({
            url,
            endpoint: path,
            error: {
              message: error.message,
              response: {
                status: error.statusCode,
                data: error.responseData,
              },
              stack: error.stack,
            },
            name: error.name,
          })}`,
          error.stack,
        );
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        const sigiloError = new SigiloPayError(
          "Timeout ao chamar SigiloPay.",
          "TIMEOUT",
        );
        this.logger.error(
          `SIGILOPAY ERROR: ${JSON.stringify({
            url,
            endpoint: path,
            message: sigiloError.message,
            name: sigiloError.name,
          })}`,
          error.stack,
        );
        throw sigiloError;
      }

      this.logger.error(
        `SIGILOPAY ERROR: ${JSON.stringify({
          url,
          endpoint: path,
          message:
            error instanceof Error
              ? error.message
              : "Erro desconhecido ao chamar SigiloPay.",
          name: error instanceof Error ? error.name : "UnknownError",
        })}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new SigiloPayError(
        error instanceof Error
          ? error.message
          : "Erro desconhecido ao chamar SigiloPay.",
        "API_ERROR",
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private assertReady() {
    if (!this.isEnabled()) {
      throw new SigiloPayError("SigiloPay desabilitada.", "CONFIG_MISSING");
    }

    if (!this.isConfigured()) {
      throw new SigiloPayError(
        "Credenciais da SigiloPay ausentes.",
        "CONFIG_MISSING",
      );
    }
  }

  private getBaseUrl() {
    return this.getEnv(
      "SIGILOPAY_API_BASE_URL",
      "https://app.sigilopay.com.br/api/v1",
    ).replace(/\/+$/, "");
  }

  private getPublicKey() {
    return this.getEnv("SIGILOPAY_PUBLIC_KEY");
  }

  private getSecretKey() {
    return this.getEnv("SIGILOPAY_SECRET_KEY");
  }

  private getWebhookToken() {
    return (
      this.getEnv("SIGILOPAY_WEBHOOK_TOKEN") ||
      this.getEnv("SIGILOPAY_WEBHOOK_SECRET")
    );
  }

  private getCallbackUrl() {
    return this.getEnv(
      "SIGILOPAY_CALLBACK_URL",
      "https://io-web.link/webhook/sigilopay",
    );
  }

  private centsToMoney(value: number) {
    return Number((value / 100).toFixed(2));
  }

  private defaultCustomerEmail(orderId: string) {
    return `cliente+${orderId}@farmacia-whatsapp-ai.local`;
  }

  private safeParseJson(value: unknown) {
    if (typeof value !== "string") {
      return value;
    }

    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }

  private getEnv(name: string, fallback = "") {
    return sanitizeEnv(
      this.configService.get<string>(name) ?? process.env[name] ?? fallback,
    );
  }

  private maskHeaders(headers: HeadersInit) {
    const record = headers as Record<string, string>;

    return {
      "Content-Type": record["Content-Type"] || record["content-type"],
      "x-public-key": this.maskCredential(record["x-public-key"]),
      "x-secret-key": this.maskCredential(record["x-secret-key"]),
    };
  }

  private maskCredential(value: unknown) {
    const sanitized = sanitizeEnv(value);

    return {
      configured: sanitized.length > 0,
      prefix: sanitized.slice(0, 4),
      length: sanitized.length,
    };
  }

  private getResponseHeaders(headers: Headers) {
    return Object.fromEntries(headers.entries());
  }

  private getApiErrorMessage(data: unknown) {
    if (data && typeof data === "object") {
      const response = data as Record<string, unknown>;
      return String(
        response.errorDescription ||
          response.message ||
          response.details ||
          "Erro retornado pela SigiloPay.",
      );
    }

    return "Erro retornado pela SigiloPay.";
  }

  private maskPix(value: string) {
    if (value.length <= 16) {
      return "***";
    }

    return `${value.slice(0, 8)}...${value.slice(-8)}`;
  }
}
