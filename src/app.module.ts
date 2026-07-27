import { existsSync } from "node:fs";
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

const HOSTINGER_ENV_FILE = ".env.hostinger";

function getEnvFilePath() {
  const customPath = process.env.HOSTINGER_ENV_FILE_PATH?.trim();

  if (customPath) {
    return [customPath];
  }

  if (existsSync(HOSTINGER_ENV_FILE)) {
    return [HOSTINGER_ENV_FILE];
  }

  return [".env"];
}

function shouldIgnoreEnvFile() {
  const explicitValue = process.env.IGNORE_ENV_FILE?.trim().toLowerCase();

  if (["true", "1", "yes", "sim"].includes(explicitValue || "")) {
    return true;
  }

  if (["false", "0", "no", "nao", "não"].includes(explicitValue || "")) {
    return false;
  }

  if (existsSync(process.env.HOSTINGER_ENV_FILE_PATH?.trim() || HOSTINGER_ENV_FILE)) {
    return false;
  }

  return process.env.NODE_ENV === "production";
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: getEnvFilePath(),
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
