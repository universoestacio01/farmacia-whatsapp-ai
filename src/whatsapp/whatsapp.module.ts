import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module";
import { IntegrationsModule } from "../integrations/integrations.module";
import { PaymentsModule } from "../payments/payments.module";
import { ConversationEngineService } from "./conversation-engine.service";
import { WhatsappService } from "./whatsapp.service";

@Module({
  imports: [AiModule, IntegrationsModule, PaymentsModule],
  providers: [ConversationEngineService, WhatsappService],
  exports: [WhatsappService],
})
export class WhatsappModule {}
