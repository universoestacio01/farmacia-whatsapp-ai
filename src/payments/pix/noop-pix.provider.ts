import { Injectable, NotImplementedException } from "@nestjs/common";
import {
  CreatePixPaymentInput,
  PixPaymentResult,
  PixProvider,
} from "./pix-provider.interface";

@Injectable()
export class NoopPixProvider implements PixProvider {
  async createPayment(
    _input: CreatePixPaymentInput,
  ): Promise<PixPaymentResult> {
    throw new NotImplementedException(
      "Pix preparado por interface. Configure um provider real antes de gerar cobrancas.",
    );
  }
}
