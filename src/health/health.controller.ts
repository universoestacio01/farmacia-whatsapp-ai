import { Controller, Get } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Controller("health")
export class HealthController {
  constructor(private readonly configService: ConfigService) {}

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
      },
    };
  }
}
