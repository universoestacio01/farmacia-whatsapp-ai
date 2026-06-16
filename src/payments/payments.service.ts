import { Inject, Injectable } from "@nestjs/common";
import {
  CreatePixPaymentInput,
  PIX_PROVIDER,
  PixProvider,
} from "./pix/pix-provider.interface";

@Injectable()
export class PaymentsService {
  constructor(
    @Inject(PIX_PROVIDER)
    private readonly pixProvider: PixProvider,
  ) {}

  createPixPayment(input: CreatePixPaymentInput) {
    return this.pixProvider.createPayment(input);
  }
}
