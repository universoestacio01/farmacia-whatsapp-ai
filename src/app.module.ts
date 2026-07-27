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

function shouldIgnoreEnvFile() {
  const explicitValue = process.env.IGNORE_ENV_FILE?.trim().toLowerCase();

  if (["true", "1", "yes", "sim"].includes(explicitValue || "")) {
    return true;
  }

  if (["false", "0", "no", "nao", "não"].includes(explicitValue || "")) {
    return false;
  }

  return process.env.NODE_ENV === "production";
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: shouldIgnoreEnvFile(),
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
