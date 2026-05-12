import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { randomInt, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../core/prisma.service.js";
import { SecurityService } from "../core/security.service.js";
import { AuthService } from "../auth/auth.service.js";
import { AdminGuard } from "../auth/guards/admin.guard.js";
import { SessionGuard } from "../auth/guards/session.guard.js";
import { AuthedRequest } from "../../common/http-types.js";
import { upstreamErrorMessage, upstreamJsonRequest } from "../../common/upstream-http.js";
import { AdminCreateUserDto, CreditsDto, GatewayDto, PatchGatewayDto, PatchRedemptionCodeDto, PatchUserDto, RedemptionCodeDto } from "./dto.js";

@UseGuards(SessionGuard, AdminGuard)
@Controller("api/admin")
export class AdminController {
  private readonly redemptionAlphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SecurityService) private readonly security: SecurityService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  private upstreamUrl(baseUrl: string, path = "") {
    const normalizedPath = String(path || "").trim();
    if (!normalizedPath) return baseUrl.replace(/\/$/, "");
    if (/^https?:\/\//i.test(normalizedPath)) return normalizedPath;
    return `${baseUrl.replace(/\/$/, "")}/${normalizedPath.replace(/^\//, "")}`;
  }

  private randomRedemptionCode(length = 16) {
    let value = "";
    for (let index = 0; index < length; index += 1) {
      value += this.redemptionAlphabet[randomInt(0, this.redemptionAlphabet.length)];
    }
    return value;
  }

  private normalizeRedemptionCode(value?: string) {
    const code = String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    return code || null;
  }

  private async uniqueRedemptionCode() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = this.randomRedemptionCode();
      const exists = await this.prisma.redemptionCode.findUnique({ where: { code } });
      if (!exists) return code;
    }
    throw new BadRequestException({ error: "CODE_GENERATION_FAILED", message: "兑换码生成失败，请重试" });
  }

  private publicGateway(gateway: any) {
    const secret = this.security.decryptSecret(gateway.apiKeyCiphertext);
    return {
      ...gateway,
      apiKey: secret ? this.security.maskSecret(secret) : "",
      apiKeyConfigured: Boolean(secret),
      apiKeyEnv: undefined,
      apiKeyCiphertext: undefined,
    };
  }

  @Get("summary")
  async summary() {
    const [users, orders, paidOrders, jobs, activeGateways, creditIssued, creditSpent, gateways] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.order.count(),
      this.prisma.order.aggregate({ where: { status: "paid" }, _sum: { amountCents: true } }),
      this.prisma.imageTask.count(),
      this.prisma.gateway.count({ where: { enabled: true } }),
      this.prisma.walletEntry.aggregate({ where: { amount: { gt: 0 } }, _sum: { amount: true } }),
      this.prisma.walletEntry.aggregate({ where: { amount: { lt: 0 } }, _sum: { amount: true } }),
      this.prisma.gateway.findMany({ orderBy: { priority: "desc" } }),
    ]);
    return {
      users,
      orders,
      paidRevenueCents: paidOrders._sum.amountCents || 0,
      jobs,
      activeGateways,
      creditIssued: creditIssued._sum.amount || 0,
      creditSpent: Math.abs(creditSpent._sum.amount || 0),
      gateways,
    };
  }

  @Get("usage")
  async usage(@Query("days") daysRaw?: string) {
    const days = Math.min(Math.max(Number(daysRaw || 14), 1), 90);
    const start = new Date();
    start.setDate(start.getDate() - (days - 1));
    start.setHours(0, 0, 0, 0);
    const tasks = await this.prisma.imageTask.findMany({ where: { createdAt: { gte: start } } });
    const daily = new Map<string, { date: string; jobs: number; succeeded: number; failed: number; credits: number }>();
    for (let index = 0; index < days; index += 1) {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      const key = date.toISOString().slice(0, 10);
      daily.set(key, { date: key, jobs: 0, succeeded: 0, failed: 0, credits: 0 });
    }
    const byModel = new Map<string, number>();
    const byGateway = new Map<string, number>();
    for (const task of tasks) {
      const key = task.createdAt.toISOString().slice(0, 10);
      const item = daily.get(key);
      if (item) {
        item.jobs += 1;
        if (task.status === "success") item.succeeded += 1;
        if (task.status === "failed") item.failed += 1;
        item.credits += task.costCredits;
      }
      byModel.set(task.model, (byModel.get(task.model) || 0) + 1);
      byGateway.set(task.gatewayId || "unknown", (byGateway.get(task.gatewayId || "unknown") || 0) + 1);
    }
    const completed = tasks.filter((task) => ["success", "failed"].includes(task.status));
    const succeeded = completed.filter((task) => task.status === "success").length;
    return {
      days,
      totals: {
        jobs: tasks.length,
        succeeded,
        failed: completed.length - succeeded,
        successRate: completed.length ? Math.round((succeeded / completed.length) * 100) : 0,
        credits: tasks.reduce((sum, task) => sum + task.costCredits, 0),
      },
      daily: [...daily.values()],
      byModel: [...byModel.entries()].map(([model, jobs]) => ({ model, jobs })),
      byGateway: [...byGateway.entries()].map(([gatewayId, jobs]) => ({ gatewayId, jobs })),
    };
  }

  @Get("users")
  async users() {
    const users = await this.prisma.user.findMany({ orderBy: { createdAt: "desc" } });
    return { users: await Promise.all(users.map((user) => this.auth.publicUser(user))) };
  }

  @Post("users")
  async createUser(@Req() req: AuthedRequest, @Body() body: AdminCreateUserDto) {
    const email = body.email.trim().toLowerCase();
    const user = await this.prisma.user.create({
      data: {
        email,
        name: body.name || email.split("@")[0],
        passwordHash: this.security.hashPassword(body.password),
        role: "user",
        status: body.status || "active",
      },
    });
    if (body.credits && body.credits > 0) {
      await this.prisma.walletEntry.create({ data: { userId: user.id, amount: body.credits, reason: "admin_adjust", refId: randomUUID(), actorId: req.user!.id } });
    }
    await this.audit(req, "user.create", user.id, { email: user.email, status: user.status, credits: body.credits || 0 });
    return { user: await this.auth.publicUser(user) };
  }

  @Patch("users/:id")
  async patchUser(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: PatchUserDto) {
    const current = await this.prisma.user.findUniqueOrThrow({ where: { id } });
    const nextStatus = body.status ?? current.status;
    const remainsActiveAdmin = current.role === "admin" && nextStatus === "active";

    if (current.role === "admin" && current.status === "active" && !remainsActiveAdmin) {
      if (req.user!.id === id) {
        throw new BadRequestException({ error: "SELF_ADMIN_LOCKOUT", message: "不能停用当前登录管理员" });
      }

      const activeAdminCount = await this.prisma.user.count({ where: { role: "admin", status: "active" } });
      if (activeAdminCount <= 1) {
        throw new BadRequestException({ error: "LAST_ADMIN", message: "至少保留一个可用管理员账号" });
      }
    }

    const user = await this.prisma.user.update({ where: { id }, data: body });
    await this.audit(req, "user.update", id, body);
    return { user: await this.auth.publicUser(user) };
  }

  @Post("credits")
  async credits(@Req() req: AuthedRequest, @Body() body: CreditsDto) {
    await this.prisma.walletEntry.create({ data: { userId: body.userId, amount: body.amount, reason: "admin_adjust", refId: randomUUID(), actorId: req.user!.id } });
    await this.audit(req, "credits.change", body.userId, { amount: body.amount, reason: body.reason || "admin_adjust" });
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: body.userId } });
    return { user: await this.auth.publicUser(user) };
  }

  @Get("gateways")
  async gateways() {
    const gateways = await this.prisma.gateway.findMany({ orderBy: { priority: "desc" } });
    return { gateways: gateways.map((gateway) => this.publicGateway(gateway)) };
  }

  @Post("gateways")
  async createGateway(@Req() req: AuthedRequest, @Body() body: GatewayDto) {
    const secretValue = String(body.apiKey || "").trim();
    const payload = {
      name: String(body.name || "").trim(),
      provider: body.provider || "openai",
      baseUrl: (body.baseUrl || "https://api.openai.com/v1").trim(),
      apiKeyEnv: null,
      apiKeyCiphertext: secretValue ? this.security.encryptSecret(secretValue) : null,
      healthCheckPath: (body.healthCheckPath || "/models").trim(),
      generationPath: (body.generationPath || "/images/generations").trim(),
      upstreamGroup: body.upstreamGroup ? String(body.upstreamGroup).trim() : null,
      model: (body.model || "gpt-image-2").trim(),
      costCredits: Number(body.costCredits ?? 8),
      timeoutMs: Number(body.timeoutMs ?? 300000),
      enabled: body.enabled === true,
      priority: Number(body.priority ?? 1),
    };
    if (!payload.name) {
      throw new BadRequestException({ error: "VALIDATION_FAILED", message: "渠道名称不能为空" });
    }
    if (!Number.isInteger(payload.costCredits) || payload.costCredits < 0) {
      throw new BadRequestException({ error: "VALIDATION_FAILED", message: "单次积分必须是非负整数" });
    }
    if (!Number.isInteger(payload.timeoutMs) || payload.timeoutMs < 1000) {
      throw new BadRequestException({ error: "VALIDATION_FAILED", message: "超时必须是不小于 1000 的整数" });
    }
    if (!Number.isInteger(payload.priority)) {
      throw new BadRequestException({ error: "VALIDATION_FAILED", message: "优先级必须是整数" });
    }

    let gateway;
    try {
      gateway = await this.prisma.gateway.create({ data: payload });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientValidationError) {
        throw new BadRequestException({ error: "VALIDATION_FAILED", message: "渠道参数格式不正确，请检查数字和布尔字段" });
      }
      throw error;
    }
    await this.audit(req, "gateway.create", gateway.id, { name: gateway.name, provider: gateway.provider, model: gateway.model });
    return { gateway: this.publicGateway(gateway) };
  }

  @Patch("gateways/:id")
  async patchGateway(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: PatchGatewayDto) {
    const patch: Record<string, unknown> = { ...body };
    if (Object.prototype.hasOwnProperty.call(body, "apiKey")) {
      const secretValue = String(body.apiKey || "").trim();
      if (/^[*•]+$/.test(secretValue)) delete patch.apiKeyCiphertext;
      else patch.apiKeyCiphertext = secretValue ? this.security.encryptSecret(secretValue) : null;
    }
    delete patch.apiKey;
    delete patch.apiKeyEnv;
    ["healthCheckPath", "generationPath", "upstreamGroup"].forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(patch, field)) {
        const value = String(patch[field] || "").trim();
        patch[field] = value || (field === "healthCheckPath" ? "/models" : field === "generationPath" ? "/images/generations" : null);
      }
    });
    const gateway = await this.prisma.gateway.update({ where: { id }, data: patch });
    await this.audit(req, "gateway.update", id, body);
    return { gateway: this.publicGateway(gateway) };
  }

  @Delete("gateways/:id")
  async deleteGateway(@Req() req: AuthedRequest, @Param("id") id: string) {
    const gateway = await this.prisma.gateway.findUniqueOrThrow({ where: { id } });
    const attachedTasks = await this.prisma.imageTask.count({
      where: { gatewayId: id, status: { in: ["queued", "processing"] } },
    });
    if (attachedTasks > 0) {
      throw new BadRequestException({ error: "GATEWAY_IN_USE", message: "该渠道仍有进行中的任务，暂时不能删除" });
    }
    await this.prisma.gateway.delete({ where: { id } });
    await this.audit(req, "gateway.delete", id, { name: gateway.name, provider: gateway.provider, model: gateway.model });
    return { ok: true, id };
  }

  @Post("gateways/:id/health-check")
  async health(@Req() req: AuthedRequest, @Param("id") id: string) {
    const gateway = await this.prisma.gateway.findUniqueOrThrow({ where: { id } });
    const started = Date.now();
    const apiKey = this.resolveGatewayApiKey(gateway);
    const keyError = gateway.apiKeyCiphertext ? "渠道 API Key 无法解密，请重新保存该渠道密钥" : "渠道 API Key 未配置";
    if (!apiKey) {
      const updated = await this.prisma.gateway.update({
        where: { id },
        data: {
          healthStatus: "degraded",
          lastCheckedAt: new Date(),
          lastFailureAt: new Date(),
          lastLatencyMs: Date.now() - started,
          lastError: keyError,
        },
      });
      await this.audit(req, "gateway.health_check", id, { ok: false, error: keyError, latencyMs: Date.now() - started });
      return { gateway: this.publicGateway(updated), ok: false, latencyMs: Date.now() - started, error: keyError };
    }

    try {
      const healthPath = gateway.healthCheckPath || "/models";
      const healthUrl = this.upstreamUrl(gateway.baseUrl, healthPath);
      const useChatPing = healthPath.includes("chat/completions");
      const response = await upstreamJsonRequest(healthUrl, {
        method: useChatPing ? "POST" : "GET",
        timeoutMs: Math.min(gateway.timeoutMs || 90000, 10000),
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        ...(useChatPing
          ? {
            body: {
            model: gateway.model,
            ...(gateway.upstreamGroup ? { group: gateway.upstreamGroup } : {}),
            messages: [{ role: "user", content: "ping" }],
            stream: false,
            },
          }
          : {}),
      });
      if (!response.ok) throw new Error(upstreamErrorMessage(response.payload, `上游返回 HTTP ${response.status}`));

      const latencyMs = Date.now() - started;
      const updated = await this.prisma.gateway.update({
        where: { id },
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
      await this.audit(req, "gateway.health_check", id, { ok: true, latencyMs });
      return { gateway: this.publicGateway(updated), ok: true, latencyMs };
    } catch (error) {
      const latencyMs = Date.now() - started;
      const message = error instanceof Error ? error.message : String(error);
      const updated = await this.prisma.gateway.update({
        where: { id },
        data: {
          healthStatus: "degraded",
          consecutiveFailures: { increment: 1 },
          lastCheckedAt: new Date(),
          lastFailureAt: new Date(),
          lastLatencyMs: latencyMs,
          lastError: message.slice(0, 1000),
        },
      });
      await this.audit(req, "gateway.health_check", id, { ok: false, error: message, latencyMs });
      return { gateway: this.publicGateway(updated), ok: false, latencyMs, error: message };
    }
  }

  private resolveGatewayApiKey(gateway: { apiKeyCiphertext?: string | null; apiKeyEnv?: string | null }) {
    if (gateway.apiKeyCiphertext) return this.security.decryptSecret(gateway.apiKeyCiphertext);
    return process.env[gateway.apiKeyEnv || "OPENAI_API_KEY"] || null;
  }

  @Post("gateways/health-check")
  async healthAll(@Req() req: AuthedRequest) {
    const gateways = await this.prisma.gateway.findMany();
    const results = [];
    for (const gateway of gateways) {
      results.push(await this.health(req, gateway.id));
    }
    await this.audit(req, "gateway.health_check_all", "gateways", { total: results.length, ok: results.filter((item) => item.ok).length });
    return { results };
  }

  @Get("jobs")
  async jobs(@Query("limit") limitRaw?: string) {
    const limit = Math.min(Math.max(Number(limitRaw || 100), 1), 500);
    const tasks = await this.prisma.imageTask.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { user: true, results: true },
    });
    return {
      jobs: tasks.map((task) => ({
        ...task,
        status: task.status === "success" ? "succeeded" : task.status === "processing" ? "running" : task.status,
        resultUrl: task.results[0]?.url || null,
        userEmail: task.user.email,
        userName: task.user.name,
      })),
    };
  }

  @Get("audit-logs")
  async auditLogs(@Query("limit") limitRaw?: string) {
    const limit = Math.min(Math.max(Number(limitRaw || 100), 1), 500);
    const logs = await this.prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: limit });
    const users = await this.prisma.user.findMany({ where: { id: { in: logs.map((log) => log.actorId).filter(Boolean) as string[] } } });
    const userMap = new Map(users.map((user) => [user.id, user]));
    return { logs: logs.map((log) => ({ ...log, actorEmail: log.actorId ? userMap.get(log.actorId)?.email || null : null, actorName: log.actorId ? userMap.get(log.actorId)?.name || null : null })) };
  }

  @Get("redemption-codes")
  async codes() {
    return { codes: await this.prisma.redemptionCode.findMany({ orderBy: { createdAt: "desc" } }) };
  }

  @Post("redemption-codes")
  async createCode(@Req() req: AuthedRequest, @Body() body: RedemptionCodeDto) {
    const batchCount = Math.max(1, Math.min(500, Number(body.batchCount || 1)));
    const manualCode = this.normalizeRedemptionCode(body.code);
    if (batchCount > 1 && manualCode) {
      throw new BadRequestException({ error: "BATCH_CODE_CONFLICT", message: "批量生成时请留空兑换码，由系统自动生成" });
    }
    if (manualCode) {
      const exists = await this.prisma.redemptionCode.findUnique({ where: { code: manualCode } });
      if (exists) {
        throw new ConflictException({ error: "CODE_EXISTS", message: "兑换码已存在，请更换一个新的代码" });
      }
    }
    const codes = [];
    for (let index = 0; index < batchCount; index += 1) {
      codes.push(await this.prisma.redemptionCode.create({
        data: {
          code: manualCode || await this.uniqueRedemptionCode(),
          credits: body.credits ?? 100,
          maxUses: body.maxUses ?? 1,
          usedBy: [],
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
          active: true,
        },
      }));
    }
    await this.audit(req, batchCount > 1 ? "redemption_code.batch_create" : "redemption_code.create", codes[0].id, { count: codes.length, codes: codes.map((item) => item.code), credits: codes[0].credits, maxUses: codes[0].maxUses });
    return { code: codes[0], codes };
  }

  @Patch("redemption-codes/:id")
  async patchCode(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: PatchRedemptionCodeDto) {
    const code = await this.prisma.redemptionCode.update({
      where: { id },
      data: {
        credits: body.credits,
        maxUses: body.maxUses,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
        active: body.active,
      },
    });
    await this.audit(req, "redemption_code.update", id, body);
    return { code };
  }

  private async audit(req: AuthedRequest, action: string, targetId?: string, meta?: unknown) {
    await this.prisma.auditLog.create({
      data: {
        actorId: req.user?.id,
        action,
        targetId,
        meta: meta as any,
        ip: req.ip,
      },
    });
  }
}
