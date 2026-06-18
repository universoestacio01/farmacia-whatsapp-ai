import { Controller, Get, Headers, Post, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ModuleRef } from "@nestjs/core";
import { getEnvPreview, sanitizeEnv } from "../config/env-sanitize";
import { PrismaService } from "../prisma/prisma.service";
import { generateValidCpf } from "../utils/cpf.util";

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
        provider: this.configService.get<string>("PIX_PROVIDER") || "none",
        enabled:
          this.configService.get<boolean>("SIGILOPAY_ENABLED") === true,
        configured: this.isSigiloPayConfigured(),
        callbackUrlConfigured: Boolean(
          this.configService.get<string>("SIGILOPAY_CALLBACK_URL")?.trim(),
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
    return this.getPaymentsHealth();
  }

  @Post("payments/test-pix")
  async testPix(@Headers("x-debug-token") debugToken: string | undefined) {
    this.assertValidDebugToken(debugToken);

    const paymentsHealth = this.getPaymentsHealth();
    const endpoint = "/gateway/pix/receive";
    const url = `${paymentsHealth.apiBaseUrl.replace(/\/+$/, "")}${endpoint}`;
    const publicKey = this.getSanitizedEnv("SIGILOPAY_PUBLIC_KEY");
    const secretKey = this.getSanitizedEnv("SIGILOPAY_SECRET_KEY");
    const documentGenerated = true;
    const payload = {
      identifier: `health_test_${Date.now()}`,
      amount: 1,
      client: {
        name: "Cliente Teste",
        email: "cliente.teste@example.com",
        phone: "11999999999",
        document: generateValidCpf(),
      },
      products: [
        {
          id: "health_test_1",
          name: "Teste Pix Farmacia",
          quantity: 1,
          price: 1,
          physical: true,
        },
      ],
      metadata: {
        provider: "farmacia-whatsapp-ai",
        diagnostic: true,
        documentGenerated,
      },
      callbackUrl: paymentsHealth.callbackUrl,
    };
    const diagnosticPayload = this.maskPixDiagnosticPayload(payload);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-public-key": publicKey,
          "x-secret-key": secretKey,
        },
        body: JSON.stringify(payload),
      });
      const text = await response.text();
      const responseBody = this.maskSensitiveData(this.parseResponseBody(text));

      return {
        ...paymentsHealth,
        url,
        endpoint,
        payload: diagnosticPayload,
        status: response.status,
        transactionId: this.getResponseValue(responseBody, "transactionId"),
        pixCodeExists: Boolean(
          this.getNestedResponseValue(responseBody, "pix", "code"),
        ),
        qrCodeExists: Boolean(
          this.getNestedResponseValue(responseBody, "pix", "base64") ||
            this.getNestedResponseValue(responseBody, "pix", "image"),
        ),
        orderUrl: this.getNestedResponseValue(responseBody, "order", "url"),
        responseBody,
      };
    } catch (error) {
      return {
        ...paymentsHealth,
        url,
        endpoint,
        payload: diagnosticPayload,
        status: null,
        responseBody: {
          error: {
            message:
              error instanceof Error ? error.message : "Erro desconhecido",
            stack: error instanceof Error ? error.stack : undefined,
          },
        },
      };
    }
  }

  private getPaymentsHealth() {
    const publicKey = getEnvPreview(
      this.getSanitizedEnv("SIGILOPAY_PUBLIC_KEY"),
    );
    const secretKey = getEnvPreview(
      this.getSanitizedEnv("SIGILOPAY_SECRET_KEY"),
    );

    return {
      provider: this.getSanitizedEnv("PIX_PROVIDER") || "none",
      enabled:
        this.configService.get<boolean>("SIGILOPAY_ENABLED") === true ||
        this.getSanitizedEnv("SIGILOPAY_ENABLED").toLowerCase() === "true",
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

  private assertValidDebugToken(debugToken: string | undefined) {
    const expectedToken = this.getSanitizedEnv("SIGILOPAY_WEBHOOK_TOKEN");

    if (!expectedToken || sanitizeEnv(debugToken) !== expectedToken) {
      throw new UnauthorizedException("Debug token inválido.");
    }
  }

  private getSanitizedEnv(name: string) {
    return sanitizeEnv(this.configService.get<string>(name) ?? process.env[name]);
  }

  private parseResponseBody(text: string) {
    if (!text) {
      return null;
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  private maskPixDiagnosticPayload(payload: unknown) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return payload;
    }

    const masked = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    const client = masked.client;

    if (client && typeof client === "object" && !Array.isArray(client)) {
      const clientRecord = client as Record<string, unknown>;
      delete clientRecord.document;
      clientRecord.documentGenerated = true;
    }

    return masked;
  }

  private getResponseValue(responseBody: unknown, key: string) {
    if (
      !responseBody ||
      typeof responseBody !== "object" ||
      Array.isArray(responseBody)
    ) {
      return undefined;
    }

    return (responseBody as Record<string, unknown>)[key];
  }

  private getNestedResponseValue(
    responseBody: unknown,
    parentKey: string,
    key: string,
  ) {
    const parent = this.getResponseValue(responseBody, parentKey);

    if (!parent || typeof parent !== "object" || Array.isArray(parent)) {
      return undefined;
    }

    return (parent as Record<string, unknown>)[key];
  }

  private maskSensitiveData(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.maskSensitiveData(item));
    }

    if (!value || typeof value !== "object") {
      return value;
    }

    const masked: Record<string, unknown> = {};

    for (const [key, item] of Object.entries(value)) {
      if (["document", "cpf"].includes(key.toLowerCase())) {
        masked[key] = "[masked]";
        continue;
      }

      masked[key] = this.maskSensitiveData(item);
    }

    return masked;
  }

  private isPharmaDbConfigured() {
    const pharmaDbBaseUrl = this.configService.get<string>(
      "PHARMADB_API_BASE_URL",
    );
    const pharmaDbApiKey = this.configService.get<string>("PHARMADB_API_KEY");

    return Boolean(pharmaDbBaseUrl && pharmaDbApiKey?.trim());
  }

  private isSigiloPayConfigured() {
    return Boolean(
      this.configService.get<string>("SIGILOPAY_PUBLIC_KEY")?.trim() &&
        this.configService.get<string>("SIGILOPAY_SECRET_KEY")?.trim(),
    );
  }

  private isSigiloPayWebhookTokenConfigured() {
    return Boolean(
      this.configService.get<string>("SIGILOPAY_WEBHOOK_TOKEN")?.trim() ||
        this.configService.get<string>("SIGILOPAY_WEBHOOK_SECRET")?.trim(),
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

  private parseTokenList(value: string | undefined) {
    return (value || "")
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean);
  }
}
