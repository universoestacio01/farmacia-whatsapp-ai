import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "../prisma/prisma.module";
import { WhatsappModule } from "../whatsapp/whatsapp.module";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";

@Module({
  imports: [ConfigModule, PrismaModule, WhatsappModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
