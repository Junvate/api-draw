import { Inject, Module, OnModuleInit } from "@nestjs/common";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { AdminGuard } from "./guards/admin.guard.js";
import { ApiKeyGuard } from "./guards/api-key.guard.js";
import { SessionGuard } from "./guards/session.guard.js";

@Module({
  controllers: [AuthController],
  providers: [AuthService, SessionGuard, AdminGuard, ApiKeyGuard],
  exports: [AuthService, SessionGuard, AdminGuard, ApiKeyGuard],
})
export class AuthModule implements OnModuleInit {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  async onModuleInit() {
    await this.authService.seed();
  }
}
