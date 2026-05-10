import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { AuthModule } from "../auth/auth.module.js";
import { IMAGE_QUEUE } from "../image/image.constants.js";
import { OperationsController } from "./operations.controller.js";

@Module({
  imports: [AuthModule, BullModule.registerQueue({ name: IMAGE_QUEUE })],
  controllers: [OperationsController],
})
export class OperationsModule {}
