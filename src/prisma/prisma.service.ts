import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";

@Injectable()
export class PrismaService implements OnModuleDestroy {
  private static client: PrismaClient | null = null;
  private readonly logger = new Logger(PrismaService.name);

  private get client() {
    if (!PrismaService.client) {
      PrismaService.client = new PrismaClient();
    }

    return PrismaService.client;
  }

  get customer() {
    return this.client.customer;
  }

  get address() {
    return this.client.address;
  }

  get conversation() {
    return this.client.conversation;
  }

  get message() {
    return this.client.message;
  }

  get order() {
    return this.client.order;
  }

  get payment() {
    return this.client.payment;
  }

  async $disconnect() {
    await this.client.$disconnect();
  }

  $queryRaw: PrismaClient["$queryRaw"] = (...args) => {
    return this.client.$queryRaw(...args);
  };

  async safePrismaCall<T>(
    operationName: string,
    callback: (prisma: PrismaClient) => Promise<T> | T,
    fallback?: T,
  ): Promise<T> {
    try {
      return await callback(this.client);
    } catch (error) {
      this.logPrismaError(operationName, error);

      if (this.isPrismaRecoverableError(error)) {
        await this.recreateClientAfterFailure(operationName);
      }

      if (arguments.length >= 3) {
        return fallback as T;
      }

      throw error;
    }
  }

  isPrismaRecoverableError(error: unknown) {
    if (!error || typeof error !== "object") {
      return false;
    }

    const name = "name" in error ? String(error.name) : "";
    const message = "message" in error ? String(error.message) : "";

    return (
      name === "PrismaClientRustPanicError" ||
      name === "PrismaClientInitializationError" ||
      name === "PrismaClientKnownRequestError" ||
      name === "PrismaClientUnknownRequestError" ||
      message.includes("PANIC: timer has gone away")
    );
  }

  isPrismaPanicError(error: unknown) {
    if (!error || typeof error !== "object") {
      return false;
    }

    const name = "name" in error ? String(error.name) : "";
    const message = "message" in error ? String(error.message) : "";

    return (
      name === "PrismaClientRustPanicError" ||
      message.includes("PANIC: timer has gone away")
    );
  }

  async onModuleDestroy() {
    await PrismaService.client?.$disconnect();
  }

  private logPrismaError(operationName: string, error: unknown) {
    const name =
      error && typeof error === "object" && "name" in error
        ? String(error.name)
        : "UnknownPrismaError";
    const message =
      error && typeof error === "object" && "message" in error
        ? String(error.message)
        : "Erro desconhecido do Prisma";

    this.logger.error(`PRISMA SAFE CALL FAILED: ${operationName}`);
    this.logger.error(`PRISMA ERROR NAME: ${name}`);
    this.logger.error(`PRISMA ERROR MESSAGE: ${message}`);

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      this.logger.error(`PRISMA ERROR CODE: ${error.code}`);
    }
  }

  private async recreateClientAfterFailure(operationName: string) {
    const failedClient = PrismaService.client;
    PrismaService.client = null;

    try {
      await failedClient?.$disconnect();
    } catch (disconnectError) {
      const message =
        disconnectError instanceof Error
          ? disconnectError.message
          : "Erro desconhecido ao desconectar Prisma";
      this.logger.error(
        `Falha ao desconectar Prisma após ${operationName}: ${message}`,
      );
    }

    PrismaService.client = new PrismaClient();
    this.logger.warn(`PrismaClient recriado após falha em ${operationName}`);
  }
}
