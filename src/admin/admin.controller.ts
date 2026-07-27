import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Query,
} from "@nestjs/common";
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
  ) {
    this.assertAuthorized(token);
    return this.adminService.listConversations(Number(limit) || 20);
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
