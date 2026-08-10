import { Controller, Get } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { existsSync } from "node:fs";
import { ModuleRef } from "@nestjs/core";
import { getEnvPreview, sanitizeEnv } from "../config/env-sanitize";
import {
  DEFAULT_STATIC_PIX_COPY_PASTE,
  DEFAULT_STATIC_PIX_KEY,
} from "../config/static-pix.config";
import { PrismaService } from "../prisma/prisma.service";

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
    const primaryProvider =
      this.configService.get<string>("MEDICINE_PRIMARY_PROVIDER") || "pharmadb";
    const pharmaDbBaseUrl = this.configService.get<string>(
      "PHARMADB_API_BASE_URL",
    );
    const pharmaDbApiKey = this.configService.get<string>("PHARMADB_API_KEY");
    const bulaApiBaseUrl =
      this.configService.get<string>("BULA_API_BASE_URL") ||
      "https://bulapi.com.br/api/v1";
    const cosmosApiBaseUrl =
      this.configService.get<string>("COSMOS_API_BASE_URL") ||
      "https://api.cosmos.bluesoft.com.br";
    const cosmosTokenCount = this.getCosmosTokenCount();

    return {
      status: "ok",
      primaryProvider,
      payments: {
        provider: "static_pix",
        enabled: true,
        configured: this.isStaticPixConfigured(),
        confirmationMode: "manual",
      },
      providers: {
        pharmadb: {
          configured: Boolean(pharmaDbBaseUrl && pharmaDbApiKey?.trim()),
          lazyAuth: true,
        },
        bulapi: {
          configured: Boolean(bulaApiBaseUrl),
        },
        cosmos: {
          configured: Boolean(cosmosApiBaseUrl && cosmosTokenCount > 0),
          tokenCount: cosmosTokenCount,
          cacheEnabled: true,
          lazy: true,
        },
      },
    };
  }

  @Get("bootstrap")
  bootstrap() {
    const cosmosTokenCount = this.getCosmosTokenCount();

    return {
      cosmosConfigured: cosmosTokenCount > 0,
      cosmosTokenCount,
      pharmadbConfigured: this.isPharmaDbConfigured(),
      databaseConfigured: Boolean(
        this.configService.get<string>("DATABASE_URL")?.trim(),
      ),
    };
  }

  @Get("payments")
  payments() {
    const pixKey = getEnvPreview(
      this.getSanitizedEnv("PIX_STATIC_KEY") || DEFAULT_STATIC_PIX_KEY,
    );
    const copyPaste =
      this.getSanitizedEnv("PIX_STATIC_COPY_PASTE") ||
      DEFAULT_STATIC_PIX_COPY_PASTE;

    return {
      status: "ok",
      provider: "static_pix",
      enabled: true,
      configured: this.isStaticPixConfigured(),
      confirmationMode: "manual",
      automaticConfirmation: false,
      pixKeyConfigured: pixKey.configured,
      pixKeyLength: pixKey.length,
      pixKeyPrefix: pixKey.prefix,
      copyPasteConfigured: Boolean(copyPaste),
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

  private getCosmosTokenCount() {
    const multiTokenValue = this.configService.get<string>("COSMOS_API_TOKENS");
    const multiTokens = this.parseTokenList(multiTokenValue);

    if (multiTokens.length > 0) {
      return Math.min(multiTokens.length, 4);
    }

    return this.parseTokenList(
      this.configService.get<string>("COSMOS_API_TOKEN"),
    ).length;
  }

  private isPharmaDbConfigured() {
    const pharmaDbBaseUrl = this.configService.get<string>(
      "PHARMADB_API_BASE_URL",
    );
    const pharmaDbApiKey = this.configService.get<string>("PHARMADB_API_KEY");

    return Boolean(pharmaDbBaseUrl && pharmaDbApiKey?.trim());
  }

  private isStaticPixConfigured() {
    return Boolean(
      (this.getSanitizedEnv("PIX_STATIC_KEY") || DEFAULT_STATIC_PIX_KEY) &&
        (this.getSanitizedEnv("PIX_STATIC_COPY_PASTE") ||
          DEFAULT_STATIC_PIX_COPY_PASTE),
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

  private parseTokenList(value: string | undefined) {
    return (value || "")
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean);
  }
}

