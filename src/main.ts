import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { AppModule } from "./app.module";

async function bootstrap() {
  const logger = new Logger("Bootstrap");
  logger.log("BOOT START");
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
  });
  const port = Number(process.env.PORT) || 3000;
  app.enableCors();
  await app.listen(port, "0.0.0.0");
  logger.log("BOOT COMPLETED");
}

void bootstrap().catch((error) => {
  const logger = new Logger("Bootstrap");
  const safeError =
    error instanceof Error
      ? error
      : new Error(typeof error === "string" ? error : JSON.stringify(error));

  logger.error(`BOOT FAILED: ${safeError.message}`);
  logger.error(`BOOT FAILED ERROR NAME: ${safeError.name}`);
  logger.error(`BOOT FAILED ERROR STACK: ${safeError.stack || "sem stack"}`);
  process.exit(1);
});
