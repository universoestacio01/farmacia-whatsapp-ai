import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AiModule } from "./ai/ai.module";
import { HealthModule } from "./health/health.module";
import { IntegrationsModule } from "./integrations/integrations.module";
import { PaymentsModule } from "./payments/payments.module";
import { PrismaModule } from "./prisma/prisma.module";
import { WebhooksModule } from "./webhooks/webhooks.module";
import { WhatsappModule } from "./whatsapp/whatsapp.module";
import { validateEnv } from "./config/env.validation";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    PrismaModule,
    HealthModule,
    AiModule,
    IntegrationsModule,
    PaymentsModule,
    WhatsappModule,
    WebhooksModule,
  ],
})
export class AppModule {}
