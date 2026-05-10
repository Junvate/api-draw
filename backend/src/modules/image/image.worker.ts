import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { Inject } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { IMAGE_QUEUE } from "./image.constants.js";
import { ImageService } from "./image.service.js";

@Processor(IMAGE_QUEUE, {
  concurrency: Number(process.env.IMAGE_WORKER_CONCURRENCY || 10),
})
export class ImageWorker extends WorkerHost {
  constructor(
    @Inject(ImageService) private readonly imageService: ImageService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {
    super();
  }

  async process(job: Job<{ taskId: string }>) {
    if (this.config.get<string>("IMAGE_WORKER_ENABLED") === "false") return null;
    return this.imageService.processTask(job.data.taskId, {
      attempt: job.attemptsMade + 1,
      maxAttempts: job.opts.attempts || 1,
    });
  }
}
