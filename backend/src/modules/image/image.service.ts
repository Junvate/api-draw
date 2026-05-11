import { BadRequestException, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { ConfigService } from "@nestjs/config";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { Gateway, ImageTask } from "@prisma/client";
import { PrismaService } from "../core/prisma.service.js";
import { SecurityService } from "../core/security.service.js";
import { upstreamErrorMessage, upstreamJsonRequest, upstreamMultipartRequest } from "../../common/upstream-http.js";
import { IMAGE_QUEUE } from "./image.constants.js";
import { CreateImageDto } from "./dto.js";

export interface UploadedImageFile {
  originalname?: string;
  mimetype?: string;
  size?: number;
  buffer: Buffer;
}

@Injectable()
export class ImageService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @InjectQueue(IMAGE_QUEUE) private readonly queue: Queue,
    @Inject(SecurityService) private readonly security: SecurityService,
  ) {}

  async seedDefaults() {
    const planCount = await this.prisma.plan.count();
    if (planCount === 0) {
      await this.prisma.plan.createMany({
        data: [
          { id: "starter", name: "入门版", credits: 300, priceCents: 2900, interval: "month", active: true },
          { id: "pro", name: "专业版", credits: 1200, priceCents: 9900, interval: "month", active: true },
          { id: "team", name: "团队版", credits: 5000, priceCents: 39900, interval: "month", active: true },
        ],
      });
    }
    const gatewayCount = await this.prisma.gateway.count();
    if (gatewayCount === 0) {
      await this.prisma.gateway.create({
        data: {
          id: "openai-primary",
          name: "OpenAI 主网关",
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          apiKeyEnv: "OPENAI_API_KEY",
          healthCheckPath: "/models",
          generationPath: "/images/generations",
          model: "gpt-image-2",
          costCredits: 8,
          timeoutMs: 90000,
          enabled: true,
          priority: 10,
        },
      });
    }
    await this.prisma.modelConfig.upsert({
      where: { model: "gpt-image-2" },
      update: {},
      create: {
        model: "gpt-image-2",
        enabled: true,
        defaultSize: "1024x1024",
        defaultQuality: "auto",
        allowTransparent: true,
        allowHighQuality: true,
        maxImagesPerRequest: 4,
      },
    });
  }

  async createTask(params: { userId: string; apiKeyId?: string; requestId?: string; dto: CreateImageDto; referenceFiles?: UploadedImageFile[] }) {
    const prompt = this.cleanFormString(params.dto.prompt).trim();
    if (prompt.length < 4) throw new BadRequestException({ error: "PROMPT_TOO_SHORT", message: "提示词至少输入 4 个字" });
    if (prompt.length > 8000) throw new BadRequestException({ error: "PROMPT_TOO_LONG", message: "提示词不能超过 8000 个字" });
    const requestedModel = this.cleanFormString(params.dto.model || "gpt-image-2") || "gpt-image-2";
    const requestedQuality = this.cleanFormString(params.dto.quality);
    const normalizedSize = this.normalizeSize(this.cleanFormString(params.dto.size || params.dto.ratio), requestedQuality);
    const gateway = await this.selectGateway(requestedModel, normalizedSize);
    const unitCost = normalizedSize === "3840x2160" ? 8 : normalizedSize === "2048x2048" ? 6 : (gateway.costCredits || 1);

    // Clamp count to [1, 4] and to model's maxImagesPerRequest if configured lower.
    const rawCount = Number.isFinite(Number(params.dto.count)) ? Number(params.dto.count) : 1;
    let imageCount = Math.max(1, Math.min(4, Math.trunc(rawCount) || 1));
    const modelConfig = await this.prisma.modelConfig.findUnique({ where: { model: gateway.model } }).catch(() => null);
    const maxPerRequest = modelConfig?.maxImagesPerRequest ?? 4;
    if (maxPerRequest > 0 && imageCount > maxPerRequest) imageCount = maxPerRequest;

    const totalCost = unitCost * imageCount;
    const referenceFiles = this.validateReferenceFiles(params.referenceFiles || []);

    const task = await this.prisma.$transaction(async (tx) => {
      // Balance check inside transaction to prevent concurrent overspend
      const balanceResult = await tx.walletEntry.aggregate({ where: { userId: params.userId }, _sum: { amount: true } });
      const balance = balanceResult._sum.amount || 0;
      if (balance < totalCost) throw new BadRequestException({ error: "INSUFFICIENT_CREDITS", message: "积分不足" });

      const task = await tx.imageTask.create({
        data: {
          userId: params.userId,
          apiKeyId: params.apiKeyId,
          requestId: params.requestId,
          gatewayId: gateway.id,
          model: gateway.model,
          prompt,
          size: normalizedSize,
          quality: this.normalizeQuality(requestedQuality),
          outputFormat: this.cleanFormString(params.dto.output_format || "png") || "png",
          background: this.cleanFormString(params.dto.background || "opaque") || "opaque",
          imageCount,
          costCredits: totalCost,
          status: "queued",
        },
      });
      await tx.walletEntry.create({
        data: {
          userId: params.userId,
          amount: -totalCost,
          reason: "generation_hold",
          refId: task.id,
          actorId: params.userId,
        },
      });
      return task;
    });
    if (referenceFiles.length) await this.persistReferenceImages(task.id, referenceFiles);
    return task;
  }

  async enqueue(taskId: string) {
    await this.queue.add("generate", { taskId }, {
      jobId: taskId,
      attempts: Number(this.config.get<string>("IMAGE_JOB_ATTEMPTS") || 3),
      backoff: { type: "exponential", delay: Number(this.config.get<string>("IMAGE_JOB_BACKOFF_MS") || 5000) },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }

  async queueTask(task: ImageTask) {
    try {
      const limit = Number(this.config.get<string>("GATEWAY_QUEUE_LIMIT") || 200);
      const counts = await this.queue.getJobCounts("waiting", "delayed");
      if (counts.waiting + counts.delayed >= limit) {
        await this.failTask(task, "QUEUE_FULL", "当前队列已满，请稍后再试", true);
        throw new ServiceUnavailableException({ error: "QUEUE_FULL", message: "当前队列已满，请稍后再试" });
      }
      await this.enqueue(task.id);
      return task;
    } catch (err: any) {
      if (err?.status === 503) throw err;
      await this.failTask(task, "QUEUE_UNAVAILABLE", "任务队列当前不可用", true);
      throw new ServiceUnavailableException({ error: "QUEUE_UNAVAILABLE", message: "任务队列当前不可用" });
    }
  }

  async processTask(taskId: string, retryContext: { attempt?: number; maxAttempts?: number } = {}) {
    const task = await this.prisma.imageTask.findUnique({ where: { id: taskId }, include: { gateway: true } });
    if (!task || !["queued", "processing"].includes(task.status)) return task;
    if (!task.gateway || !task.gateway.enabled || this.isCooling(task.gateway)) {
      return this.failTask(task, "GATEWAY_UNAVAILABLE", "任务网关当前不可用", true);
    }

    const started = Date.now();
    // Atomic claim: only proceed if task is still queued (prevents duplicate execution)
    const claimed = await this.prisma.imageTask.updateMany({
      where: { id: task.id, status: "queued" },
      data: { status: "processing", startedAt: new Date() },
    });
    if (claimed.count === 0) return task; // already claimed by another worker

    try {
      const results = await this.callGateway(task, task.gateway);
      const latencyMs = Date.now() - started;
      const returnedCount = results.length;
      const shortfall = Math.max(0, task.imageCount - returnedCount);
      const unitCost = task.imageCount > 0 ? task.costCredits / task.imageCount : task.costCredits;
      const refundAmount = shortfall > 0 ? Math.round(unitCost * shortfall) : 0;
      const finalCost = task.costCredits - refundAmount;

      const updated = await this.prisma.$transaction(async (tx) => {
        await tx.imageResult.createMany({
          data: results.map((r) => ({
            taskId: task.id,
            url: r.url,
            format: r.format,
            width: r.width ?? undefined,
            height: r.height ?? undefined,
            storageKey: r.storageKey ?? undefined,
          })),
        });
        if (refundAmount > 0) {
          await tx.walletEntry.create({
            data: {
              userId: task.userId,
              amount: refundAmount,
              reason: "generation_refund",
              refId: task.id,
              actorId: task.userId,
            },
          });
        }
        await tx.usageRecord.create({
          data: {
            userId: task.userId,
            apiKeyId: task.apiKeyId,
            taskId: task.id,
            model: task.model,
            imageCount: returnedCount,
            costCredits: finalCost,
            latencyMs,
            status: "success",
          },
        });
        await tx.gateway.update({
          where: { id: task.gatewayId! },
          data: {
            healthStatus: "healthy",
            consecutiveFailures: 0,
            disabledUntil: null,
            lastCheckedAt: new Date(),
            lastSuccessAt: new Date(),
            lastLatencyMs: latencyMs,
            lastError: null,
          },
        });
        return tx.imageTask.update({
          where: { id: task.id },
          data: { status: "success", latencyMs, finishedAt: new Date(), costCredits: finalCost },
          include: { results: true },
        });
      });
      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.recordGatewayFailure(task.gateway, message, Date.now() - started);
      const attempt = retryContext.attempt || 1;
      const maxAttempts = retryContext.maxAttempts || 1;
      if (attempt < maxAttempts) {
        await this.prisma.imageTask.update({
          where: { id: task.id },
          data: {
            status: "queued",
            retryCount: attempt,
            errorCode: "UPSTREAM_RETRYING",
            errorMessage: message.slice(0, 1000),
          },
        });
        throw error;
      }
      return this.failTask(task, "UPSTREAM_FAILED", message, true);
    }
  }

  async failTask(task: ImageTask, code: string, message: string, refund: boolean) {
    return this.prisma.$transaction(async (tx) => {
      const existingRefund = await tx.walletEntry.findFirst({ where: { refId: task.id, reason: "generation_refund" } });
      if (refund && !existingRefund) {
        await tx.walletEntry.create({
          data: {
            userId: task.userId,
            amount: task.costCredits,
            reason: "generation_refund",
            refId: task.id,
            actorId: task.userId,
          },
        });
      }
      await tx.usageRecord.upsert({
        where: { taskId: task.id },
        update: { status: "failed", costCredits: 0 },
        create: {
          userId: task.userId,
          apiKeyId: task.apiKeyId,
          taskId: task.id,
          model: task.model,
          imageCount: task.imageCount,
          costCredits: 0,
          status: "failed",
        },
      });
      return tx.imageTask.update({
        where: { id: task.id },
        data: { status: "failed", errorCode: code, errorMessage: message.slice(0, 1000), finishedAt: new Date() },
      });
    });
  }

  async recoverPendingTasks() {
    const tasks = await this.prisma.imageTask.findMany({
      where: { status: { in: ["queued", "processing"] } },
      orderBy: { createdAt: "asc" },
      select: { id: true, status: true },
    });
    for (const task of tasks) {
      if (task.status === "processing") {
        await this.prisma.imageTask.update({ where: { id: task.id }, data: { status: "queued" } });
      }
      await this.enqueue(task.id);
    }
    return tasks.length;
  }

  async publicTask(task: ImageTask & { results?: Array<{ url: string }> }, userId: string) {
    const resultsList = task.results || [];
    const returnedCount = resultsList.length;
    const imageUrls = resultsList.map((item, index) => {
      // If stored via our backend, prefer the indexed display URL so clients can download specific variants.
      const displayUrl = `/api/images/${task.id}/result${index === 0 ? "" : `?i=${index}`}`;
      const downloadUrl = `/api/images/${task.id}/download${index === 0 ? "" : `?i=${index}`}`;
      return {
        url: item.url,
        display_url: displayUrl,
        displayUrl,
        download_url: downloadUrl,
        downloadUrl,
      };
    });
    return {
      object: "image_generation",
      id: task.id,
      task_id: task.id,
      status: this.publicStatus(task.status),
      model: task.model,
      ratio: task.size,
      size: task.size,
      quality: task.quality,
      prompt: task.prompt,
      result_url: resultsList[0]?.url || null,
      resultUrl: resultsList[0]?.url || null,
      display_url: returnedCount ? `/api/images/${task.id}/result` : null,
      displayUrl: returnedCount ? `/api/images/${task.id}/result` : null,
      download_url: returnedCount ? `/api/images/${task.id}/download` : null,
      downloadUrl: returnedCount ? `/api/images/${task.id}/download` : null,
      images: imageUrls,
      image_count: task.imageCount,
      imageCount: task.imageCount,
      returned_count: returnedCount,
      returnedCount,
      error: task.errorMessage || null,
      cost_credits: task.costCredits,
      costCredits: task.costCredits,
      credits_remaining: await this.prisma.walletBalance(userId),
      created_at: task.createdAt,
      createdAt: task.createdAt,
      completed_at: task.finishedAt || null,
      completedAt: task.finishedAt || null,
    };
  }

  private async selectGateway(model: string, size: string) {
    const gateways = await this.prisma.gateway.findMany({
      where: {
        enabled: true,
        model,
        OR: [{ disabledUntil: null }, { disabledUntil: { lt: new Date() } }],
      },
      orderBy: [{ priority: "desc" }],
    });
    const preferredGroup = this.groupForSize(size);
    const available = gateways.filter((item) => Boolean(this.resolveGatewayApiKey(item, false)));
    const gateway = available.find((item) => item.upstreamGroup === preferredGroup) || available.find((item) => !item.upstreamGroup) || available[0];
    if (!gateway) throw new ServiceUnavailableException({ error: "NO_AVAILABLE_GATEWAY", message: "没有可用网关" });
    return gateway;
  }

  private async callGateway(task: ImageTask, gateway: Gateway): Promise<GeneratedImage[]> {
    const apiKey = this.resolveGatewayApiKey(gateway);
    if (!apiKey) throw new Error("渠道 API Key 未配置");
    const referenceImages = await this.loadReferenceImages(task.id);
    if (referenceImages.length) return this.callGatewayEdit(task, gateway, apiKey, referenceImages);
    return this.callGatewayGeneration(task, gateway, apiKey);
  }

  private async callGatewayGeneration(task: ImageTask, gateway: Gateway, apiKey: string): Promise<GeneratedImage[]> {
    const generationPath = (gateway as any).generationPath || "/images/generations";
    const upstreamGroup = (gateway as any).upstreamGroup || this.groupForSize(task.size);
    const response = await upstreamJsonRequest<{ error?: { message?: string }; data?: Array<{ b64_json?: string; url?: string }> }>(
      this.upstreamUrl(gateway.baseUrl, generationPath),
      {
        method: "POST",
        timeoutMs: gateway.timeoutMs,
        headers: { Authorization: `Bearer ${apiKey}` },
        body: {
          model: task.model,
          ...(upstreamGroup ? { group: upstreamGroup } : {}),
          prompt: task.prompt,
          size: task.size,
          output_format: task.outputFormat,
          response_format: "url",
          background: task.background,
          n: task.imageCount,
        },
      },
    );
    const payload = response.payload;
    if (!response.ok) throw new Error(upstreamErrorMessage(payload, `上游返回 HTTP ${response.status}`));
    const entries = Array.isArray(payload.data) ? payload.data : [];
    const valid = entries.filter((item) => item?.url || item?.b64_json);
    if (valid.length === 0) throw new Error("图像网关没有返回结果");
    return this.materializeImages(task, valid);
  }

  private async callGatewayEdit(task: ImageTask, gateway: Gateway, apiKey: string, referenceImages: LoadedReferenceImage[]): Promise<GeneratedImage[]> {
    const editPath = this.editPathForGateway(gateway);
    const upstreamGroup = (gateway as any).upstreamGroup || this.groupForSize(task.size);
    const parts = [
      { name: "model", value: task.model },
      ...(upstreamGroup ? [{ name: "group", value: upstreamGroup }] : []),
      { name: "prompt", value: task.prompt },
      { name: "size", value: task.size },
      { name: "response_format", value: "url" },
      { name: "n", value: String(task.imageCount) },
      ...referenceImages.map((image) => ({
        name: "image",
        value: image.buffer,
        filename: image.filename,
        contentType: image.contentType,
      })),
    ];
    const response = await upstreamMultipartRequest<{ error?: { message?: string }; data?: Array<{ b64_json?: string; url?: string }> }>(
      this.upstreamUrl(gateway.baseUrl, editPath),
      {
        method: "POST",
        timeoutMs: gateway.timeoutMs,
        headers: { Authorization: `Bearer ${apiKey}` },
        parts,
      },
    );
    const payload = response.payload;
    if (!response.ok) throw new Error(upstreamErrorMessage(payload, `上游返回 HTTP ${response.status}`));
    const entries = Array.isArray(payload.data) ? payload.data : [];
    const valid = entries.filter((item) => item?.url || item?.b64_json);
    if (valid.length === 0) throw new Error("图像编辑网关没有返回结果");
    return this.materializeImages(task, valid);
  }

  private async materializeImages(task: ImageTask, entries: Array<{ b64_json?: string; url?: string }>): Promise<GeneratedImage[]> {
    const out: GeneratedImage[] = [];
    for (let i = 0; i < entries.length; i++) {
      const item = entries[i]!;
      if (item.url) {
        out.push({ url: item.url, format: task.outputFormat, width: null, height: null, storageKey: null });
        continue;
      }
      const stored = await this.persistGeneratedImage(task, item.b64_json!, task.outputFormat, i);
      out.push({ url: stored.url, format: task.outputFormat, width: null, height: null, storageKey: stored.storageKey });
    }
    return out;
  }

  private editPathForGateway(gateway: Gateway) {
    const generationPath = String((gateway as any).generationPath || "/images/generations");
    if (generationPath.includes("/images/edits")) return generationPath;
    if (generationPath.includes("/images/generations")) return generationPath.replace("/images/generations", "/images/edits");
    return "/images/edits";
  }

  private upstreamUrl(baseUrl: string, path = "") {
    const normalizedPath = String(path || "").trim();
    if (!normalizedPath) return baseUrl.replace(/\/$/, "");
    if (/^https?:\/\//i.test(normalizedPath)) return normalizedPath;
    return `${baseUrl.replace(/\/$/, "")}/${normalizedPath.replace(/^\//, "")}`;
  }

  private resolveGatewayApiKey(gateway: Gateway, throwOnInvalid = true) {
    if (gateway.apiKeyCiphertext) {
      const decrypted = this.security.decryptSecret(gateway.apiKeyCiphertext);
      if (decrypted) return decrypted;
      if (throwOnInvalid) throw new Error("渠道 API Key 无法解密，请重新保存该渠道密钥");
      return null;
    }
    const envKey = process.env[gateway.apiKeyEnv || "OPENAI_API_KEY"];
    if (envKey) return envKey;
    if (throwOnInvalid) throw new Error("渠道 API Key 未配置");
    return null;
  }

  private async persistGeneratedImage(task: ImageTask, b64: string, format: string, variantIndex = 0) {
    const safeFormat = ["png", "jpeg", "jpg", "webp"].includes(format) ? format : "png";
    const storageRoot = this.config.get<string>("LOCAL_STORAGE_DIR") || "storage";
    const dir = join(process.cwd(), storageRoot, "images");
    const ext = safeFormat === "jpeg" ? "jpg" : safeFormat;
    // Single-image tasks keep legacy filename (<taskId>.<ext>) so pre-existing files still resolve.
    // Multi-image tasks use <taskId>-<n>.<ext> where n is 1-based.
    const filename = variantIndex === 0 ? `${task.id}.${ext}` : `${task.id}-${variantIndex + 1}.${ext}`;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, filename), Buffer.from(b64, "base64"));
    const publicUrl = variantIndex === 0 ? `/api/images/${task.id}/result` : `/api/images/${task.id}/result?i=${variantIndex}`;
    return {
      storageKey: `images/${filename}`,
      url: publicUrl,
    };
  }

  private validateReferenceFiles(files: UploadedImageFile[]) {
    const cleanFiles = files.filter((file) => file?.buffer?.length);
    if (cleanFiles.length > 3) throw new BadRequestException({ error: "TOO_MANY_REFERENCE_IMAGES", message: "参考图最多上传 3 张" });
    for (const file of cleanFiles) {
      if (!file.mimetype?.startsWith("image/")) {
        throw new BadRequestException({ error: "INVALID_REFERENCE_IMAGE", message: "参考图必须是图片文件" });
      }
      if ((file.size || file.buffer.length) > 10 * 1024 * 1024) {
        throw new BadRequestException({ error: "REFERENCE_IMAGE_TOO_LARGE", message: "单张参考图不能超过 10MB" });
      }
    }
    return cleanFiles;
  }

  private async persistReferenceImages(taskId: string, files: UploadedImageFile[]) {
    const dir = join(process.cwd(), this.config.get<string>("LOCAL_STORAGE_DIR") || "storage", "references", taskId);
    await mkdir(dir, { recursive: true });
    await Promise.all(files.map((file, index) => {
      const extension = this.extensionForMime(file.mimetype, file.originalname);
      return writeFile(join(dir, `${String(index + 1).padStart(2, "0")}.${extension}`), file.buffer);
    }));
  }

  private async loadReferenceImages(taskId: string): Promise<LoadedReferenceImage[]> {
    const dir = join(process.cwd(), this.config.get<string>("LOCAL_STORAGE_DIR") || "storage", "references", taskId);
    let files: string[] = [];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }
    const selected = files
      .filter((file) => /\.(png|jpe?g|webp)$/i.test(file))
      .sort()
      .slice(0, 3);
    return Promise.all(selected.map(async (file) => {
      const extension = extname(file).replace(".", "").toLowerCase();
      return {
        filename: file,
        contentType: this.mimeForExtension(extension),
        buffer: await readFile(join(dir, file)),
      };
    }));
  }

  private extensionForMime(mimetype?: string, filename?: string) {
    const byMime = ({
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/jpg": "jpg",
      "image/webp": "webp",
    } as Record<string, string>)[String(mimetype || "").toLowerCase()];
    if (byMime) return byMime;
    const extension = extname(filename || "").replace(".", "").toLowerCase();
    return ["png", "jpg", "jpeg", "webp"].includes(extension) ? (extension === "jpeg" ? "jpg" : extension) : "png";
  }

  private mimeForExtension(extension: string) {
    if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
    if (extension === "webp") return "image/webp";
    return "image/png";
  }

  private async recordGatewayFailure(gateway: Gateway, message: string, latencyMs: number) {
    const failures = gateway.consecutiveFailures + 1;
    const threshold = Number(this.config.get<string>("GATEWAY_FAILURE_THRESHOLD") || 3);
    const cooldownMs = Number(this.config.get<string>("GATEWAY_COOLDOWN_MS") || 300000);
    await this.prisma.gateway.update({
      where: { id: gateway.id },
      data: {
        healthStatus: failures >= threshold ? "down" : "degraded",
        consecutiveFailures: failures,
        disabledUntil: failures >= threshold ? new Date(Date.now() + cooldownMs) : null,
        lastCheckedAt: new Date(),
        lastFailureAt: new Date(),
        lastLatencyMs: latencyMs,
        lastError: message.slice(0, 1000),
      },
    });
  }

  private publicStatus(status: string) {
    return ({ processing: "running", success: "succeeded" } as Record<string, string>)[status] || status;
  }

  private isCooling(gateway: Gateway) {
    return gateway.disabledUntil && gateway.disabledUntil.getTime() > Date.now();
  }

  private normalizeSize(value?: string, quality?: string) {
    if (quality === "超清(4k)" || quality === "high") return "3840x2160";
    if (quality === "高清(2k)" || quality === "medium") return "2048x2048";
    if (!value || value === "自动" || value === "Auto" || value === "auto") return "1024x1024";
    if (value === "1:1") return "1024x1024";
    if (value === "16:9") return "1536x1024";
    if (value === "9:16") return "1024x1536";
    return value;
  }

  private cleanFormString(value?: string | null) {
    const text = String(value || "").trim();
    if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
      return text.slice(1, -1).trim();
    }
    return text;
  }

  private normalizeQuality(value?: string) {
    if (!value || value === "自动(1k)" || value === "auto") return "auto";
    if (value === "高清(2k)") return "medium";
    if (value === "超清(4k)") return "high";
    return value;
  }

  private groupForSize(size: string) {
    if (size === "3840x2160") return "GPT-Image-2-4k";
    if (size === "2048x2048") return "GPT-Image-2-2k";
    return undefined;
  }
}

interface LoadedReferenceImage {
  filename: string;
  contentType: string;
  buffer: Buffer;
}

interface GeneratedImage {
  url: string;
  format: string;
  width: number | null;
  height: number | null;
  storageKey: string | null;
}
