import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

interface PharmaDbTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  tier?: string;
}

@Injectable()
export class PharmaDbAuthService {
  private readonly logger = new Logger(PharmaDbAuthService.name);
  private accessToken: string | null = null;
  private expiresAt = 0;

  constructor(private readonly configService: ConfigService) {}

  hasApiKey() {
    return Boolean(this.configService.get<string>("PHARMADB_API_KEY")?.trim());
  }

  async getAccessToken(forceRefresh = false) {
    if (!this.hasApiKey()) {
      return null;
    }

    const now = Date.now();

    if (!forceRefresh && this.accessToken && now < this.expiresAt - 60_000) {
      return this.accessToken;
    }

    return this.refreshToken();
  }

  clearToken() {
    this.accessToken = null;
    this.expiresAt = 0;
  }

  private async refreshToken() {
    const apiKey = this.configService.get<string>("PHARMADB_API_KEY")?.trim();

    if (!apiKey) {
      return null;
    }

    const baseUrl = this.getBaseUrl();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const response = await fetch(`${this.getAuthBaseUrl(baseUrl)}/auth/token`, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          Accept: "application/json",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        this.logger.warn(`PharmaDB auth respondeu ${response.status}`);
        return null;
      }

      const data = (await response.json()) as PharmaDbTokenResponse;

      if (!data.access_token) {
        this.logger.warn("PharmaDB auth não retornou access_token");
        return null;
      }

      this.accessToken = data.access_token;
      this.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
      this.logger.log(`PharmaDB token renovado. Tier: ${data.tier || "n/a"}`);
      return this.accessToken;
    } catch (error) {
      this.logger.warn(
        `Falha ao autenticar na PharmaDB: ${
          error instanceof Error ? error.message : "erro desconhecido"
        }`,
      );
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private getBaseUrl() {
    return (
      this.configService.get<string>("PHARMADB_API_BASE_URL") ||
      "https://api.pharmadb.com.br/v1"
    ).replace(/\/$/, "");
  }

  private getAuthBaseUrl(baseUrl: string) {
    return baseUrl.replace(/\/v1$/, "");
  }
}
