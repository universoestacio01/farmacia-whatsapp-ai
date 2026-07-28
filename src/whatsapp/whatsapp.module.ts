import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module";
import { IntegrationsModule } from "../integrations/integrations.module";
import { PaymentsModule } from "../payments/payments.module";
import { ObservabilityModule } from "../observability/observability.module";
import { ConversationInputService } from "./conversation-input.service";
import { ConversationEngineService } from "./conversation-engine.service";
import { WhatsappMediaService } from "./whatsapp-media.service";
import { WhatsappWebhookQueueService } from "./whatsapp-webhook-queue.service";
import { WhatsappService } from "./whatsapp.service";

@Module({
  imports: [AiModule, IntegrationsModule, PaymentsModule, ObservabilityModule],
  providers: [
    ConversationInputService,
    ConversationEngineService,
    WhatsappMediaService,
    WhatsappWebhookQueueService,
    WhatsappService,
  ],
  exports: [WhatsappService, WhatsappWebhookQueueService],
})
export class WhatsappModule {}
