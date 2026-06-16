import { Module } from "@nestjs/common";
import { WhatsappModule } from "../whatsapp/whatsapp.module";
import { WhatsappWebhookController } from "./whatsapp-webhook.controller";

@Module({
  imports: [WhatsappModule],
  controllers: [WhatsappWebhookController],
})
export class WebhooksModule {}
