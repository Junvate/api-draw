import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Inject, Param, Post, Req, UploadedFiles, UseGuards, UseInterceptors } from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import { ApiKeyGuard } from "../auth/guards/api-key.guard.js";
import { AuthedRequest } from "../../common/http-types.js";
import { AuthService } from "../auth/auth.service.js";
import { PrismaService } from "../core/prisma.service.js";
import { CreateImageDto } from "../image/dto.js";
import { ImageService, UploadedImageFile } from "../image/image.service.js";

@UseGuards(ApiKeyGuard)
@Controller("api/v1")
export class PublicApiController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ImageService) private readonly imageService: ImageService,
  ) {}

  @Get("me")
  async me(@Req() req: AuthedRequest) {
    return {
      object: "account",
      user: await this.auth.publicUser(req.user!),
      api_key: this.auth.publicApiKey(req.apiKey!),
    };
  }

  @Post("images/generations")
  @UseInterceptors(FilesInterceptor("image", 3, { limits: { fileSize: 10 * 1024 * 1024, files: 3 } }))
  @HttpCode(HttpStatus.ACCEPTED)
  async create(
    @Req() req: AuthedRequest,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: CreateImageDto,
    @UploadedFiles() files: UploadedImageFile[] = [],
  ) {
    if (idempotencyKey) {
      const existing = await this.prisma.imageTask.findFirst({
        where: { apiKeyId: req.apiKey!.id, requestId: idempotencyKey },
        include: { results: true },
      });
      if (existing) {
        return { object: "image_generation.response", data: await this.imageService.publicTask(existing, req.user!.id) };
      }
    }
    const task = await this.imageService.createTask({ userId: req.user!.id, apiKeyId: req.apiKey!.id, requestId: idempotencyKey, dto: body, referenceFiles: files });
    if (body.response_mode === "async") {
      await this.imageService.queueTask(task);
      return { object: "image_generation.response", data: await this.imageService.publicTask(task, req.user!.id) };
    }
    const completed = await this.imageService.processTask(task.id);
    return { object: "image_generation.response", data: await this.imageService.publicTask(completed as any, req.user!.id) };
  }

  @Post("images/edits")
  @UseInterceptors(FilesInterceptor("image", 3, { limits: { fileSize: 10 * 1024 * 1024, files: 3 } }))
  @HttpCode(HttpStatus.ACCEPTED)
  async edit(
    @Req() req: AuthedRequest,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: CreateImageDto,
    @UploadedFiles() files: UploadedImageFile[] = [],
  ) {
    return this.create(req, idempotencyKey, body, files);
  }

  @Get("images/generations/:taskId")
  async getTask(@Req() req: AuthedRequest, @Param("taskId") taskId: string) {
    const task = await this.prisma.imageTask.findFirstOrThrow({
      where: { id: taskId, userId: req.user!.id },
      include: { results: true },
    });
    return { object: "image_generation.response", data: await this.imageService.publicTask(task, req.user!.id) };
  }
}
