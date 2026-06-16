import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Query,
  RawBodyRequest,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Request } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { WhatsappService } from "../whatsapp/whatsapp.service";
import { WhatsappWebhookPayload } from "./dto/whatsapp-webhook.dto";

@Controller("webhooks/whatsapp")
export class WhatsappWebhookController {
  constructor(
    private readonly configService: ConfigService,
    private readonly whatsappService: WhatsappService,
  ) {}

  @Get()
  verifyWebhook(
    @Query("hub.mode") mode?: string,
    @Query("hub.verify_token") token?: string,
    @Query("hub.challenge") challenge?: string,
  ) {
    const verifyToken = this.configService.get<string>("WHATSAPP_VERIFY_TOKEN");

    if (mode === "subscribe" && token && token === verifyToken) {
      return challenge || "";
    }

    throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  receiveMessage(
    @Body() payload: WhatsappWebhookPayload,
    @Headers("x-hub-signature-256") signature: string | undefined,
    @Req() request: RawBodyRequest<Request>,
  ) {
    if (!this.isValidSignature(signature, request.rawBody)) {
      throw new UnauthorizedException("Assinatura do webhook invalida");
    }

    this.whatsappService.enqueueWebhook(payload);
    return { received: true };
  }

  private isValidSignature(signature: string | undefined, rawBody?: Buffer) {
    if (!signature || !rawBody) {
      return false;
    }

    const appSecret = this.configService.getOrThrow<string>(
      "WHATSAPP_APP_SECRET",
    );
    const expectedSignature = `sha256=${createHmac("sha256", appSecret)
      .update(rawBody)
      .digest("hex")}`;

    const received = Buffer.from(signature, "utf8");
    const expected = Buffer.from(expectedSignature, "utf8");

    return (
      received.length === expected.length && timingSafeEqual(received, expected)
    );
  }
}
