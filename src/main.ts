import { join } from "path";
import * as express from "express";
import type { Request, Response } from "express";
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
  const publicPath = join(process.cwd(), "public");
  const expressApp = app.getHttpAdapter().getInstance();

  expressApp.use(
    express.static(publicPath, {
      index: false,
      maxAge: "1d",
    }),
  );

  expressApp.get("/", (_request: Request, response: Response) => {
    response.sendFile(join(publicPath, "index.html"));
  });

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
