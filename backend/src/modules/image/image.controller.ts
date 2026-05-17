import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Req, UploadedFiles, UseGuards, UseInterceptors } from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import { PrismaService } from "../core/prisma.service.js";
import { SessionGuard } from "../auth/guards/session.guard.js";
import { AuthedRequest } from "../../common/http-types.js";
import { CreateImageDto } from "./dto.js";
import { ImageService, UploadedImageFile } from "./image.service.js";

@Controller("api")
export class ImageController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ImageService) private readonly imageService: ImageService,
  ) {}

  @UseGuards(SessionGuard)
  @Post("generate")
  @UseInterceptors(FilesInterceptor("image[]", 16, { limits: { fileSize: 50 * 1024 * 1024, files: 16 } }))
  @HttpCode(HttpStatus.ACCEPTED)
  async generate(@Req() req: AuthedRequest, @Body() body: CreateImageDto, @UploadedFiles() files: UploadedImageFile[] = []) {
    const task = await this.imageService.createTask({ userId: req.user!.id, dto: body, referenceFiles: files });
    if (body.response_mode === "async") {
      await this.imageService.queueTask(task);
      return {
        job: await this.imageService.publicTask(task, req.user!.id),
        credits: await this.prisma.walletBalance(req.user!.id),
      };
    }
    const completed = await this.imageService.processTask(task.id);
    return {
      job: await this.imageService.publicTask(completed as any, req.user!.id),
      credits: await this.prisma.walletBalance(req.user!.id),
    };
  }

  @UseGuards(SessionGuard)
  @Get("jobs")
  async jobs(@Req() req: AuthedRequest) {
    const tasks = await this.prisma.imageTask.findMany({
      where: req.user!.role === "admin" ? {} : { userId: req.user!.id },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { results: true, user: true },
    });
    return {
      jobs: await Promise.all(tasks.map(async (task) => ({
        ...await this.imageService.publicTask(task, req.user!.id),
        ownerEmail: task.user.email,
        ownerName: task.user.name,
        ownedByMe: task.userId === req.user!.id,
      }))),
    };
  }

  @UseGuards(SessionGuard)
  @Get("jobs/:taskId")
  async job(@Req() req: AuthedRequest, @Param("taskId") taskId: string) {
    const task = await this.prisma.imageTask.findFirstOrThrow({
      where: { id: taskId, ...(req.user!.role === "admin" ? {} : { userId: req.user!.id }) },
      include: { results: true, user: true },
    });
    return {
      job: {
        ...await this.imageService.publicTask(task, req.user!.id),
        ownerEmail: task.user.email,
        ownerName: task.user.name,
        ownedByMe: task.userId === req.user!.id,
      },
    };
  }
}
