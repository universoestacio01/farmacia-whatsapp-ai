import { Controller, Get } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ModuleRef } from "@nestjs/core";
import { getEnvPreview, sanitizeEnv } from "../config/env-sanitize";
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
        provider: this.getSanitizedEnv("PIX_PROVIDER") || "none",
        enabled: this.isSigiloPayEnabled(),
        configured: this.isSigiloPayConfigured(),
        callbackUrlConfigured: Boolean(
          this.getSanitizedEnv("SIGILOPAY_CALLBACK_URL"),
        ),
        webhookTokenConfigured: this.isSigiloPayWebhookTokenConfigured(),
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
    const publicKey = getEnvPreview(
      this.getSanitizedEnv("SIGILOPAY_PUBLIC_KEY"),
    );
    const secretKey = getEnvPreview(
      this.getSanitizedEnv("SIGILOPAY_SECRET_KEY"),
    );

    return {
      provider: this.getSanitizedEnv("PIX_PROVIDER") || "none",
      enabled: this.isSigiloPayEnabled(),
      apiBaseUrl:
        this.getSanitizedEnv("SIGILOPAY_API_BASE_URL") ||
        "https://app.sigilopay.com.br/api/v1",
      publicKeyConfigured: publicKey.configured,
      publicKeyLength: publicKey.length,
      publicKeyPrefix: publicKey.prefix,
      secretKeyConfigured: secretKey.configured,
      secretKeyLength: secretKey.length,
      secretKeyPrefix: secretKey.prefix,
      callbackUrl:
        this.getSanitizedEnv("SIGILOPAY_CALLBACK_URL") ||
        "https://io-web.link/webhook/sigilopay",
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

  private isSigiloPayEnabled() {
    return (
      this.configService.get<boolean>("SIGILOPAY_ENABLED") === true ||
      this.getSanitizedEnv("SIGILOPAY_ENABLED").toLowerCase() === "true"
    );
  }

  private isSigiloPayConfigured() {
    return Boolean(
      this.getSanitizedEnv("SIGILOPAY_PUBLIC_KEY") &&
        this.getSanitizedEnv("SIGILOPAY_SECRET_KEY"),
    );
  }

  private isSigiloPayWebhookTokenConfigured() {
    return Boolean(
      this.getSanitizedEnv("SIGILOPAY_WEBHOOK_TOKEN") ||
        this.getSanitizedEnv("SIGILOPAY_WEBHOOK_SECRET"),
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

  private parseTokenList(value: string | undefined) {
    return (value || "")
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean);
  }
}
