import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { OrderStatus } from "@prisma/client";
import { ConfigService } from "@nestjs/config";
import { sanitizeEnv } from "../config/env-sanitize";
import { AdminService } from "./admin.service";

@Controller("admin/api")
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly configService: ConfigService,
  ) {}

  @Get("session")
  session(@Headers("x-admin-token") token?: string) {
    return {
      protected: this.hasAdminToken(),
      authenticated: this.isAuthorized(token),
    };
  }

  @Get("overview")
  overview(@Headers("x-admin-token") token?: string) {
    this.assertAuthorized(token);
    return this.adminService.overview();
  }

  @Get("conversations")
  conversations(
    @Headers("x-admin-token") token?: string,
    @Query("limit") limit?: string,
    @Query("search") search?: string,
    @Query("state") state?: string,
    @Query("status") status?: string,
  ) {
    this.assertAuthorized(token);
    return this.adminService.listConversations(Number(limit) || 20, {
      search,
      state,
      status,
    });
  }

  @Get("attention")
  attention(
    @Headers("x-admin-token") token?: string,
    @Query("limit") limit?: string,
  ) {
    this.assertAuthorized(token);
    return this.adminService.attentionQueue(Number(limit) || 30);
  }

  @Get("conversations/:id/messages")
  conversationMessages(
    @Headers("x-admin-token") token: string | undefined,
    @Param("id") id: string,
    @Query("limit") limit?: string,
  ) {
    this.assertAuthorized(token);
    return this.adminService.conversationMessages(id, Number(limit) || 60);
  }

  @Get("orders")
  orders(
    @Headers("x-admin-token") token?: string,
    @Query("limit") limit?: string,
  ) {
    this.assertAuthorized(token);
    return this.adminService.listOrders(Number(limit) || 20);
  }

  @Get("orders/:id")
  orderDetails(
    @Headers("x-admin-token") token: string | undefined,
    @Param("id") id: string,
  ) {
    this.assertAuthorized(token);
    return this.adminService.orderDetails(id);
  }

  @Patch("orders/:id/status")
  updateOrderStatus(
    @Headers("x-admin-token") token: string | undefined,
    @Param("id") id: string,
    @Body("status") status: OrderStatus,
  ) {
    this.assertAuthorized(token);

    if (!Object.values(OrderStatus).includes(status)) {
      throw new ForbiddenException("Status de pedido inválido.");
    }

    return this.adminService.updateOrderStatus(id, status);
  }

  @Post("conversations/:id/messages")
  sendManualMessage(
    @Headers("x-admin-token") token: string | undefined,
    @Param("id") id: string,
    @Body("text") text: string,
  ) {
    this.assertAuthorized(token);

    if (!text?.trim()) {
      throw new ForbiddenException("Mensagem vazia.");
    }

    return this.adminService.sendManualMessage(id, text.trim());
  }

  @Post("conversations/:id/reset")
  resetConversation(
    @Headers("x-admin-token") token: string | undefined,
    @Param("id") id: string,
  ) {
    this.assertAuthorized(token);
    return this.adminService.resetConversation(id);
  }

  @Post("conversations/:id/close")
  closeConversation(
    @Headers("x-admin-token") token: string | undefined,
    @Param("id") id: string,
  ) {
    this.assertAuthorized(token);
    return this.adminService.closeConversation(id);
  }

  @Get("errors")
  errors(
    @Headers("x-admin-token") token?: string,
    @Query("limit") limit?: string,
  ) {
    this.assertAuthorized(token);
    return this.adminService.errors(Number(limit) || 30);
  }

  @Get("providers")
  providers(@Headers("x-admin-token") token?: string) {
    this.assertAuthorized(token);
    return this.adminService.providers();
  }

  @Get("database")
  database(@Headers("x-admin-token") token?: string) {
    this.assertAuthorized(token);
    return this.adminService.database();
  }

  private assertAuthorized(token?: string) {
    if (!this.isAuthorized(token)) {
      throw new ForbiddenException("Token administrativo inválido.");
    }
  }

  private isAuthorized(token?: string) {
    const expected = this.adminToken();

    if (!expected) {
      return true;
    }

    return sanitizeEnv(token) === expected;
  }

  private hasAdminToken() {
    return Boolean(this.adminToken());
  }

  private adminToken() {
    return sanitizeEnv(
      this.configService.get<string>("ADMIN_TOKEN") ?? process.env.ADMIN_TOKEN,
    );
  }
}
