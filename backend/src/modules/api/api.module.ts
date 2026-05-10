import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { ImageModule } from "../image/image.module.js";
import { PublicApiController } from "./public-api.controller.js";

@Module({
  imports: [AuthModule, ImageModule],
  controllers: [PublicApiController],
})
export class ApiModule {}
