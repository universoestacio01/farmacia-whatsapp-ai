import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
  });
  const configService = app.get(ConfigService);
  const port = configService.get<number>("PORT") || 3000;

  app.enableCors();
  await app.listen(port, "0.0.0.0");
}

void bootstrap();
