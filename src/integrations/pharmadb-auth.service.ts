import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sanitizeEnv } from "../config/env-sanitize";
import { PHARMADB_BASE_URL } from "../config/medicine-backups.config";

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
  private pending: Promise<string | null> | null = null;
  private unavailableUntil = 0;
  private failureStatus?: number;

  getFailureStatus() { return this.failureStatus; }

  constructor(private readonly configService: ConfigService) {}

  hasApiKey() {
    return Boolean(sanitizeEnv(this.configService.get("PHARMADB_API_KEY")));
  }

  async getAccessToken(forceRefresh = false) {
    if (!this.hasApiKey()) {
      return null;
    }

    if (Date.now() < this.unavailableUntil) return null;

    const now = Date.now();

    if (!forceRefresh && this.accessToken && now < this.expiresAt - 60_000) {
      return this.accessToken;
    }

    if (!this.pending) this.pending = this.refreshToken().finally(() => { this.pending = null; });
    return this.pending;
  }

  clearToken() {
    this.accessToken = null;
    this.expiresAt = 0;
  }

  private async refreshToken() {
    const apiKey = sanitizeEnv(this.configService.get("PHARMADB_API_KEY"));

    if (!apiKey) {
      return null;
    }

    const baseUrl = this.getBaseUrl();
    this.failureStatus = undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);

    try {
      const response = await fetch(`${this.getAuthBaseUrl(baseUrl)}/auth/token`, {
        redirect: "error",
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          Accept: "application/json",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        this.failureStatus = response.status;
        this.unavailableUntil = Date.now() + (response.status === 429 ? 300_000 : 60_000);
        this.logger.warn(`PharmaDB auth respondeu ${response.status}`);
        return null;
      }

      const data = (await response.json()) as PharmaDbTokenResponse;

      if (!data.access_token || typeof data.access_token !== "string") {
        this.unavailableUntil = Date.now() + 60_000;
        this.logger.warn("PharmaDB auth não retornou access_token");
        return null;
      }

      this.accessToken = data.access_token;
      this.failureStatus = undefined;
      this.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
      this.logger.log(`PharmaDB token renovado. Tier: ${data.tier || "n/a"}`);
      return this.accessToken;
    } catch (error) {
      this.unavailableUntil = Date.now() + 60_000;
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
      sanitizeEnv(this.configService.get("PHARMADB_API_BASE_URL")) || PHARMADB_BASE_URL
    ).replace(/\/$/, "");
  }

  private getAuthBaseUrl(baseUrl: string) {
    return baseUrl.replace(/\/v1$/, "");
  }
}
