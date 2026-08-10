import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import {
  DEFAULT_PIX_KEY,
  DEFAULT_PIX_MERCHANT_CITY,
  DEFAULT_PIX_MERCHANT_NAME,
} from "../config/direct-pix.config";
import { sanitizeEnv } from "../config/env-sanitize";
import { generatePixBrCode } from "../utils/pix-br-code.util";
import {
  CreatePixPaymentInput,
  PixPaymentResult,
  PixProvider,
} from "./pix/pix-provider.interface";

@Injectable()
export class DirectPixService implements PixProvider {
  private readonly logger = new Logger(DirectPixService.name);

  constructor(private readonly configService: ConfigService) {}

  async createPayment(
    input: CreatePixPaymentInput,
  ): Promise<PixPaymentResult> {
    const txid = this.createTxid(input.orderId, input.amountCents);
    const pixCopyPaste = generatePixBrCode({
      key: this.getPixKey(),
      amountCents: input.amountCents,
      merchantName: this.getMerchantName(),
      merchantCity: this.getMerchantCity(),
      txid,
    });

    this.logger.log(
      `DIRECT PIX GENERATED: order=${input.orderId}, amountCents=${input.amountCents}, txid=${txid}`,
    );

    return {
      provider: "pix_direct",
      providerPaymentId: txid,
      providerTransactionId: txid,
      pixPayload: pixCopyPaste,
      pixCopyPaste,
      rawResponse: {
        mode: "direct_key",
        amountCents: input.amountCents,
        txid,
        automaticConfirmation: false,
      },
    };
  }

  isConfigured() {
    return Boolean(
      this.getPixKey() && this.getMerchantName() && this.getMerchantCity(),
    );
  }

  getPixKey() {
    return (
      this.getEnv("PIX_KEY") ||
      this.getEnv("PIX_STATIC_KEY") ||
      DEFAULT_PIX_KEY
    );
  }

  getMerchantName() {
    return this.getEnv("PIX_MERCHANT_NAME") || DEFAULT_PIX_MERCHANT_NAME;
  }

  getMerchantCity() {
    return this.getEnv("PIX_MERCHANT_CITY") || DEFAULT_PIX_MERCHANT_CITY;
  }

  private createTxid(orderId: string, amountCents: number) {
    const hash = createHash("sha256")
      .update(`${orderId}:${amountCents}`)
      .digest("hex");
    return `RD${hash.slice(0, 23)}`.toUpperCase();
  }

  private getEnv(name: string) {
    return sanitizeEnv(
      this.configService.get<string>(name) ?? process.env[name],
    );
  }
}
