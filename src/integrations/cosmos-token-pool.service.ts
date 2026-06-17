import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

interface TokenState {
  token: string;
  invalid: boolean;
  rateLimitedUntil: number;
}

export interface CosmosTokenSelection {
  token: string;
  index: number;
}

@Injectable()
export class CosmosTokenPoolService {
  private readonly logger = new Logger(CosmosTokenPoolService.name);
  private readonly tokens: TokenState[];
  private nextIndex = 0;

  constructor(private readonly configService: ConfigService) {
    this.tokens = this.loadTokens().map((token) => ({
      token,
      invalid: false,
      rateLimitedUntil: 0,
    }));

    if (this.tokens.length > 1) {
      this.logger.log("COSMOS TOKEN POOL ENABLED");
    }
  }

  selectToken(): CosmosTokenSelection | null {
    if (this.tokens.length === 0) {
      this.logger.warn("COSMOS nao configurado, usando catalogo manual");
      return null;
    }

    const now = Date.now();

    for (let offset = 0; offset < this.tokens.length; offset += 1) {
      const index = (this.nextIndex + offset) % this.tokens.length;
      const state = this.tokens[index];

      if (!state.invalid && state.rateLimitedUntil <= now) {
        this.nextIndex = (index + 1) % this.tokens.length;
        this.logger.log(`COSMOS TOKEN SELECTED index=${index}`);
        return { token: state.token, index };
      }
    }

    this.logger.warn("COSMOS ALL TOKENS UNAVAILABLE");
    return null;
  }

  markRateLimited(index: number) {
    const state = this.tokens[index];

    if (!state) {
      return;
    }

    const cooldownMinutes = Number(
      this.configService.get<number | string>(
        "COSMOS_TOKEN_429_COOLDOWN_MINUTES",
      ) ?? 30,
    );
    const safeCooldown =
      Number.isFinite(cooldownMinutes) && cooldownMinutes > 0
        ? cooldownMinutes
        : 30;

    state.rateLimitedUntil = Date.now() + safeCooldown * 60 * 1000;
    this.logger.warn(`COSMOS TOKEN RATE LIMITED index=${index}`);
  }

  markInvalid(index: number) {
    const state = this.tokens[index];

    if (!state) {
      return;
    }

    state.invalid = true;
    this.logger.warn(`COSMOS TOKEN INVALID index=${index}`);
  }

  isConfigured() {
    return this.tokens.length > 0;
  }

  tokenCount() {
    return this.tokens.length;
  }

  private loadTokens() {
    const multiTokenValue = this.configService.get<string>("COSMOS_API_TOKENS");
    const tokens = this.parseTokens(multiTokenValue);

    if (tokens.length > 0) {
      return tokens.slice(0, 4);
    }

    return this.parseTokens(
      this.configService.get<string>("COSMOS_API_TOKEN"),
    ).slice(0, 1);
  }

  private parseTokens(value: string | undefined) {
    return (value || "")
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean);
  }
}
