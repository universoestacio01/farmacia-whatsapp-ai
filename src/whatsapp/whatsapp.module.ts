import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module";
import { WhatsappService } from "./whatsapp.service";

@Module({
  imports: [AiModule],
  providers: [WhatsappService],
  exports: [WhatsappService],
})
export class WhatsappModule {}
