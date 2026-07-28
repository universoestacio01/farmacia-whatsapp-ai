import { Injectable, Logger } from "@nestjs/common";
import { ProviderRequestOutcome, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { RequestContext } from "./request-context.service";

export interface ProviderRequestLogInput {
  provider: string;
  operation: string;
  query?: string | null;
  endpoint?: string | null;
  statusCode?: number | null;
  durationMs?: number | null;
  resultsFound?: number | null;
  resultsAfterFilter?: number | null;
  outcome: ProviderRequestOutcome;
  failureReason?: string | null;
  errorMessage?: string | null;
  rawPayload?: unknown;
}

@Injectable()
export class ProviderRequestLogService {
  private readonly logger = new Logger(ProviderRequestLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(input: ProviderRequestLogInput) {
    try {
      await this.prisma.safePrismaCall(
        "provider_request_log.create",
        (prisma) =>
          prisma.providerRequestLog.create({
            data: {
              traceId: RequestContext.traceId(),
              provider: input.provider,
              operation: input.operation,
              query: input.query || undefined,
              endpoint: input.endpoint || undefined,
              statusCode: input.statusCode ?? undefined,
              durationMs: input.durationMs ?? undefined,
              resultsFound: input.resultsFound ?? undefined,
              resultsAfterFilter: input.resultsAfterFilter ?? undefined,
              outcome: input.outcome,
              failureReason: input.failureReason || undefined,
              errorMessage: input.errorMessage || undefined,
              rawPayload: this.toJson(input.rawPayload),
            },
          }),
        undefined,
      );
    } catch (error) {
      this.logger.warn(
        `Falha ao registrar log de provider: ${
          error instanceof Error ? error.message : "erro desconhecido"
        }`,
      );
    }
  }

  private toJson(value: unknown): Prisma.InputJsonValue | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }

    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
