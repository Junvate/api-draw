import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service.js";
import { SecurityService } from "./security.service.js";

@Global()
@Module({
  providers: [PrismaService, SecurityService],
  exports: [PrismaService, SecurityService],
})
export class CoreModule {}
