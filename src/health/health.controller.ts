import { Controller, Get } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { existsSync } from "node:fs";
import { ModuleRef } from "@nestjs/core";
import { webMedicineConfig } from "../config/web-medicine.config";
import {
  DEFAULT_PIX_KEY,
  DEFAULT_PIX_MERCHANT_CITY,
  DEFAULT_PIX_MERCHANT_NAME,
} from "../config/direct-pix.config";
import { getEnvPreview, sanitizeEnv } from "../config/env-sanitize";
import { PrismaService } from "../prisma/prisma.service";
import { getPrecoPopularMultiplier, isPrecoPopularEnabled, PRECO_POPULAR_BASE_URL } from "../config/preco-popular.config";

@Controller("health")
export class HealthController {
  constructor(
    private readonly configService: ConfigService,
    private readonly moduleRef: ModuleRef,
  ) {}

  @Get()
  check() {
    return { status: "ok" };
  }

  @Get("providers")
  providers() {
    const precoPopularEnabled = isPrecoPopularEnabled(this.configService.get("PRECO_POPULAR_ENABLED"));
    const backups = { openai_web: webMedicineConfig(this.configService) };
    const fallbackProviders = Object.entries(backups).filter(([, provider]) => provider.enabled && provider.configured).map(([name]) => name);

    return {
      status: "ok",
      primaryProvider: precoPopularEnabled ? "preco_popular" : null,
      medicineFallbackProvider: fallbackProviders[0] || null,
      medicineFallbackProviders: fallbackProviders,
      connectivityChecked: false,
      retailPrimaryProvider: precoPopularEnabled ? "preco_popular" : null,
      payments: {
        provider: "pix_direct",
        enabled: true,
        configured: this.isDirectPixConfigured(),
        confirmationMode: "manual",
        amountEmbedded: true,
      },
      providers: {
        preco_popular: {
          configured: precoPopularEnabled,
          enabled: precoPopularEnabled,
          baseUrl: PRECO_POPULAR_BASE_URL,
          priceMultiplier: getPrecoPopularMultiplier(this.configService.get("PRECO_POPULAR_PRICE_MULTIPLIER")),
          cacheEnabled: true,
          lazy: true,
        },
        ...backups,
        pharmadb: { configured: false, enabled: false, retired: true },
        bulapi: { configured: false, enabled: false, retired: true },
        cosmos: {
          configured: false,
          enabled: false,
          retired: true,
        },
      },
    };
  }

  @Get("bootstrap")
  bootstrap() {
    return {
      precoPopularEnabled: isPrecoPopularEnabled(this.configService.get("PRECO_POPULAR_ENABLED")),
      cosmosConfigured: false,
      cosmosTokenCount: 0,
      pharmadbConfigured: false,
      openaiWebConfigured: webMedicineConfig(this.configService).configured,
      databaseConfigured: Boolean(
        this.configService.get<string>("DATABASE_URL")?.trim(),
      ),
    };
  }

  @Get("payments")
  payments() {
    const pixKey = getEnvPreview(
      this.getPixKey(),
    );

    return {
      status: "ok",
      provider: "pix_direct",
      enabled: true,
      configured: this.isDirectPixConfigured(),
      confirmationMode: "manual",
      automaticConfirmation: false,
      amountEmbedded: true,
      copyPasteGeneratedPerOrder: true,
      pixKeyConfigured: pixKey.configured,
      pixKeyLength: pixKey.length,
      pixKeyPrefix: pixKey.prefix,
      merchantNameConfigured: Boolean(
        this.getSanitizedEnv("PIX_MERCHANT_NAME") ||
          DEFAULT_PIX_MERCHANT_NAME,
      ),
      merchantCityConfigured: Boolean(
        this.getSanitizedEnv("PIX_MERCHANT_CITY") ||
          DEFAULT_PIX_MERCHANT_CITY,
      ),
    };
  }

  @Get("whatsapp")
  whatsapp() {
    const accessToken = getEnvPreview(
      this.getSanitizedEnv("WHATSAPP_ACCESS_TOKEN"),
    );
    const phoneNumberId = getEnvPreview(
      this.getSanitizedEnv("WHATSAPP_PHONE_NUMBER_ID"),
    );
    const appSecret = getEnvPreview(
      this.getSanitizedEnv("WHATSAPP_APP_SECRET"),
    );
    const verifyToken = getEnvPreview(
      this.getSanitizedEnv("WHATSAPP_VERIFY_TOKEN"),
    );
    const apiVersion =
      this.getSanitizedEnv("WHATSAPP_API_VERSION") || "v25.0";

    return {
      status: "ok",
      apiVersion,
      envFileIgnored: this.isEnvFileIgnored(),
      envSource: this.getEnvSource(),
      webhookUrl: "https://farmaciadeliveryraia.com/webhooks/whatsapp",
      accessTokenConfigured: accessToken.configured,
      accessTokenLength: accessToken.length,
      accessTokenPrefix: accessToken.prefix,
      phoneNumberIdConfigured: phoneNumberId.configured,
      phoneNumberIdLength: phoneNumberId.length,
      phoneNumberIdPrefix: phoneNumberId.prefix,
      appSecretConfigured: appSecret.configured,
      appSecretLength: appSecret.length,
      appSecretPrefix: appSecret.prefix,
      verifyTokenConfigured: verifyToken.configured,
      verifyTokenLength: verifyToken.length,
      verifyTokenPrefix: verifyToken.prefix,
    };
  }

  @Get("database")
  async database() {
    return {
      databaseConfigured: Boolean(
        this.configService.get<string>("DATABASE_URL")?.trim(),
      ),
      databaseConnected: await this.isDatabaseConnected(),
    };
  }


  private isDirectPixConfigured() {
    return Boolean(
      this.getPixKey() &&
        (this.getSanitizedEnv("PIX_MERCHANT_NAME") ||
          DEFAULT_PIX_MERCHANT_NAME) &&
        (this.getSanitizedEnv("PIX_MERCHANT_CITY") ||
          DEFAULT_PIX_MERCHANT_CITY),
    );
  }

  private getPixKey() {
    return (
      this.getSanitizedEnv("PIX_KEY") ||
      this.getSanitizedEnv("PIX_STATIC_KEY") ||
      DEFAULT_PIX_KEY
    );
  }

  private async isDatabaseConnected() {
    try {
      const prisma = this.moduleRef.get(PrismaService, { strict: false });
      await prisma.safePrismaCall("health.database.SELECT_1", (client) =>
        client.$queryRaw`SELECT 1`,
      );
      return true;
    } catch {
      return false;
    }
  }

  private getSanitizedEnv(name: string) {
    return sanitizeEnv(this.configService.get<string>(name) ?? process.env[name]);
  }

  private isEnvFileIgnored() {
    const explicitValue = sanitizeEnv(process.env.IGNORE_ENV_FILE).toLowerCase();

    if (["true", "1", "yes", "sim"].includes(explicitValue)) {
      return true;
    }

    if (["false", "0", "no", "nao", "não"].includes(explicitValue)) {
      return false;
    }

    return (
      sanitizeEnv(process.env.NODE_ENV) === "production" &&
      !this.hasHostingerEnvFile()
    );
  }

  private getEnvSource() {
    if (this.hasHostingerEnvFile()) {
      return "hostinger_env_file";
    }

    if (this.isEnvFileIgnored()) {
      return "hostinger_panel";
    }

    return "local_env_file";
  }

  private hasHostingerEnvFile() {
    const customPath = sanitizeEnv(process.env.HOSTINGER_ENV_FILE_PATH);
    return Boolean(
      customPath ? existsSync(customPath) : existsSync(".env.hostinger"),
    );
  }

}

