import { BadRequestException, Body, Controller, Get, Inject, NotImplementedException, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { URL } from "node:url";
import { Response } from "express";
import { Queue } from "bullmq";
import { InjectQueue } from "@nestjs/bullmq";
import { PrismaService } from "../core/prisma.service.js";
import { IMAGE_QUEUE } from "../image/image.constants.js";
import { SessionGuard } from "../auth/guards/session.guard.js";
import { AuthedRequest } from "../../common/http-types.js";

@Controller()
export class OperationsController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @InjectQueue(IMAGE_QUEUE) private readonly queue: Queue,
  ) {}

  @Get("admin")
  admin(@Res() res: Response) {
    res.sendFile("admin.html", { root: "public" });
  }

  @Get("admin/")
  adminSlash(@Res() res: Response) {
    res.sendFile("admin.html", { root: "public" });
  }

  @Get("workspace")
  workspace(@Res() res: Response) {
    res.sendFile("workspace.html", { root: "public" });
  }

  @Get("api/health")
  health() {
    return { ok: true, version: "1.0.0-nest", time: new Date().toISOString() };
  }

  @Get("api/ready")
  async ready() {
    const counts = await this.queue.getJobCounts("waiting", "active", "completed", "failed", "delayed");
    return {
      ok: true,
      store: "postgresql",
      redis: true,
      gateway: {
        distributed: true,
        concurrency: Number(process.env.GATEWAY_CONCURRENCY || 8),
        active: counts.active,
        queued: counts.waiting + counts.delayed,
      },
      queue: {
        mode: "bullmq",
        waiting: counts.waiting,
        active: counts.active,
        completed: counts.completed,
        failed: counts.failed,
        delayed: counts.delayed,
        localQueued: 0,
        processed: counts.completed,
        recovered: 0,
      },
      time: new Date().toISOString(),
    };
  }

  @Get("api/metrics")
  async metrics(@Res() res: Response) {
    const [users, tasks, succeeded, failed, gateways, counts] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.imageTask.count(),
      this.prisma.imageTask.count({ where: { status: "success" } }),
      this.prisma.imageTask.count({ where: { status: "failed" } }),
      this.prisma.gateway.groupBy({ by: ["healthStatus"], _count: { healthStatus: true } }),
      this.queue.getJobCounts("waiting", "active", "completed", "failed", "delayed"),
    ]);
    const health = Object.fromEntries(gateways.map((item) => [item.healthStatus, item._count.healthStatus]));
    res.type("text/plain").send([
      "# TYPE app_users_total gauge",
      `app_users_total ${users}`,
      "# TYPE image_tasks_total gauge",
      `image_tasks_total ${tasks}`,
      "# TYPE image_tasks_succeeded_total gauge",
      `image_tasks_succeeded_total ${succeeded}`,
      "# TYPE image_tasks_failed_total gauge",
      `image_tasks_failed_total ${failed}`,
      "# TYPE image_queue_waiting gauge",
      `image_queue_waiting ${counts.waiting}`,
      "# TYPE image_queue_active gauge",
      `image_queue_active ${counts.active}`,
      "# TYPE image_queue_completed_total counter",
      `image_queue_completed_total ${counts.completed}`,
      "# TYPE image_queue_failed_total counter",
      `image_queue_failed_total ${counts.failed}`,
      `gateway_health_status{status="healthy"} ${health.healthy || 0}`,
      `gateway_health_status{status="degraded"} ${health.degraded || 0}`,
      `gateway_health_status{status="down"} ${health.down || 0}`,
      `gateway_health_status{status="unknown"} ${health.unknown || 0}`,
      "",
    ].join("\n"));
  }

  @Get("api/openapi.json")
  openapi() {
    return {
      openapi: "3.1.0",
      info: { title: "GPT Image 2 Gateway API", version: "1.0.0" },
      paths: {
        "/api/v1/images/generations": { post: { summary: "Create image generation task" } },
        "/api/v1/images/generations/{taskId}": { get: { summary: "Get image task" } },
        "/api/ready": { get: { summary: "Readiness probe" } },
      },
    };
  }

  @UseGuards(SessionGuard)
  @Get("api/images/:taskId/result")
  async result(@Req() req: AuthedRequest, @Param("taskId") taskId: string, @Res() res: Response) {
    return this.serveImageResult(taskId, req.user!.id, res, false);
  }

  @UseGuards(SessionGuard)
  @Get("api/images/:taskId/download")
  async download(@Req() req: AuthedRequest, @Param("taskId") taskId: string, @Res() res: Response) {
    return this.serveImageResult(taskId, req.user!.id, res, true);
  }

  private async serveImageResult(taskId: string, userId: string, res: Response, attachment: boolean) {
    const task = await this.prisma.imageTask.findUnique({ where: { id: taskId }, include: { results: true } });
    if (!task || task.userId !== userId) return res.status(404).send("Not found");
    const result = task.results[0];
    if (!result) return res.status(404).send("Not found");
    const filename = this.downloadFilename(task?.prompt || taskId, result.format || "png");
    if (attachment) res.setHeader("Content-Disposition", this.contentDisposition(filename));
    if (!result.storageKey && /^https?:\/\//i.test(result.url)) return this.proxyRemoteImage(result.url, result.format || "png", res);
    if (!result.storageKey) return res.status(404).send("Not found");
    const filePath = join(process.cwd(), process.env.LOCAL_STORAGE_DIR || "storage", result.storageKey);
    if (!existsSync(filePath)) return res.status(404).send("Not found");
    return res.type(result.format || "png").sendFile(filePath);
  }

  private downloadFilename(prompt: string, format: string) {
    const safeFormat = ["png", "jpeg", "jpg", "webp"].includes(format) ? format : "png";
    const stem = Array.from(String(prompt || "").normalize("NFKC"))
      .filter((char) => /[\p{L}\p{N}_-]/u.test(char))
      .slice(0, 16)
      .join("") || "gpt-image";
    return `${stem}.${safeFormat === "jpeg" ? "jpg" : safeFormat}`;
  }

  private contentDisposition(filename: string) {
    const extension = filename.split(".").pop() || "png";
    const fallbackStem = filename
      .replace(/\.[^.]+$/, "")
      .normalize("NFKD")
      .replace(/[^\x20-\x7E]/g, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "gpt-image";
    const asciiFallback = `${fallbackStem}.${extension}`;
    return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  }

  private proxyRemoteImage(rawUrl: string, format: string, res: Response, redirects = 0) {
    const url = new URL(rawUrl);
    const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
    let ca: Buffer | undefined;
    if (url.protocol === "https:") {
      try {
        ca = readFileSync("/etc/ssl/cert.pem");
      } catch {}
    }
    const req = requester(url, { method: "GET", timeout: 30000, ...(ca ? { ca } : {}) }, (upstream) => {
      const location = upstream.headers.location;
      if ([301, 302, 303, 307, 308].includes(upstream.statusCode || 0) && location && redirects < 3) {
        upstream.resume();
        const nextUrl = new URL(location, url).toString();
        return this.proxyRemoteImage(nextUrl, format, res, redirects + 1);
      }
      if ((upstream.statusCode || 0) < 200 || (upstream.statusCode || 0) >= 300) {
        upstream.resume();
        if (!res.headersSent) res.status(upstream.statusCode || 502).send("Remote image unavailable");
        return;
      }
      res.setHeader("Cache-Control", "public, max-age=14400");
      res.setHeader("Content-Type", upstream.headers["content-type"] || `image/${format}`);
      if (upstream.headers["content-length"]) res.setHeader("Content-Length", upstream.headers["content-length"]);
      upstream.pipe(res);
    });
    req.on("timeout", () => req.destroy(new Error("Remote image timeout")));
    req.on("error", () => {
      if (!res.headersSent) res.status(502).send("Remote image unavailable");
    });
    req.end();
  }

  @Get("api/plans")
  async plans() {
    return { plans: await this.prisma.plan.findMany({ where: { active: true }, orderBy: { priceCents: "asc" } }) };
  }

  @UseGuards(SessionGuard)
  @Post("api/billing/checkout")
  async checkout(@Req() req: AuthedRequest, @Body() body: { planId: string }) {
    const plan = await this.prisma.plan.findUniqueOrThrow({ where: { id: body.planId } });
    const order = await this.prisma.order.create({
      data: { userId: req.user!.id, planId: plan.id, amountCents: plan.priceCents, currency: "CNY", provider: "manual" },
    });
    throw new NotImplementedException({
      error: "PAYMENT_PROVIDER_NOT_CONFIGURED",
      message: "真实支付链路尚未配置，已创建订单但不会执行模拟支付。",
      order,
      plan,
    });
  }

  @UseGuards(SessionGuard)
  @Post("api/redeem")
  async redeem(@Req() req: AuthedRequest, @Body() body: { code: string }) {
    const code = String(body.code || "").trim().toUpperCase();
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const record = await tx.redemptionCode.findUniqueOrThrow({ where: { code } });
      if (
        !record.active ||
        (record.expiresAt && record.expiresAt < now) ||
        record.usedBy.includes(req.user!.id) ||
        record.usedBy.length >= record.maxUses
      ) {
        throw new BadRequestException({ error: "CODE_USED", message: "兑换码不可用" });
      }
      await tx.redemptionCode.update({ where: { id: record.id }, data: { usedBy: [...record.usedBy, req.user!.id] } });
      await tx.walletEntry.create({ data: { userId: req.user!.id, amount: record.credits, reason: "redeem_code", refId: record.id, actorId: req.user!.id } });
    });
    return { credits: await this.prisma.walletBalance(req.user!.id), added: record.credits };
  }
}
