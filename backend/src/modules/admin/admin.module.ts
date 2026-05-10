import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { AdminController } from "./admin.controller.js";

@Module({
  imports: [AuthModule],
  controllers: [AdminController],
})
export class AdminModule {}
