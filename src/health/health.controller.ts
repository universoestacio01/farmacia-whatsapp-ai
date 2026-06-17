import { Controller, Get } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ModuleRef } from "@nestjs/core";
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
