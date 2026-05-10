import { Inject, Module, OnModuleInit } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { AuthModule } from "../auth/auth.module.js";
import { ImageController } from "./image.controller.js";
import { IMAGE_QUEUE } from "./image.constants.js";
import { ImageService } from "./image.service.js";
import { ImageWorker } from "./image.worker.js";

@Module({
  imports: [AuthModule, BullModule.registerQueue({ name: IMAGE_QUEUE })],
  controllers: [ImageController],
  providers: [ImageService, ImageWorker],
  exports: [ImageService],
})
export class ImageModule implements OnModuleInit {
  constructor(@Inject(ImageService) private readonly imageService: ImageService) {}

  async onModuleInit() {
    await this.imageService.seedDefaults();
    await this.imageService.recoverPendingTasks();
  }
}
