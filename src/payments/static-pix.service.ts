import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sanitizeEnv } from "../config/env-sanitize";
import {
  DEFAULT_STATIC_PIX_COPY_PASTE,
  DEFAULT_STATIC_PIX_KEY,
} from "../config/static-pix.config";
import {
  CreatePixPaymentInput,
  PixPaymentResult,
  PixProvider,
} from "./pix/pix-provider.interface";

@Injectable()
export class StaticPixService implements PixProvider {
  private readonly logger = new Logger(StaticPixService.name);

  constructor(private readonly configService: ConfigService) {}

  async createPayment(
    input: CreatePixPaymentInput,
  ): Promise<PixPaymentResult> {
    const pixCopyPaste = this.getCopyPaste();

    if (!pixCopyPaste) {
      throw new Error("Pix estatico nao configurado.");
    }

    this.logger.log(
      `STATIC PIX PREPARED: order=${input.orderId}, amountCents=${input.amountCents}`,
    );

    return {
      provider: "static_pix",
      pixPayload: pixCopyPaste,
      pixCopyPaste,
      rawResponse: {
        mode: "static",
        automaticConfirmation: false,
        pixKeyConfigured: Boolean(this.getPixKey()),
      },
    };
  }

  isConfigured() {
    return Boolean(this.getPixKey() && this.getCopyPaste());
  }

  getPixKey() {
    return this.getEnv("PIX_STATIC_KEY") || DEFAULT_STATIC_PIX_KEY;
  }

  getCopyPaste() {
    return (
      this.getEnv("PIX_STATIC_COPY_PASTE") || DEFAULT_STATIC_PIX_COPY_PASTE
    )
      .trim()
      .replace(/[\r\n\t]/g, "");
  }

  private getEnv(name: string) {
    return sanitizeEnv(
      this.configService.get<string>(name) ?? process.env[name],
    );
  }
}
