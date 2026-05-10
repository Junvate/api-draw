import { ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Response } from "express";
import { ApiKey, User } from "@prisma/client";
import { PrismaService } from "../core/prisma.service.js";
import { SecurityService } from "../core/security.service.js";

@Injectable()
export class AuthService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SecurityService) private readonly security: SecurityService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  async seed() {
    const seedAdminEmail = this.config.get<string>("SEED_ADMIN_EMAIL")?.trim().toLowerCase();
    const seedAdminPassword = this.config.get<string>("SEED_ADMIN_PASSWORD");
    if (!seedAdminEmail || !seedAdminPassword) return;

    const existing = await this.prisma.user.findUnique({ where: { email: seedAdminEmail } });
    if (existing) return;

    const admin = await this.prisma.user.create({
      data: {
        email: seedAdminEmail,
        name: this.config.get<string>("SEED_ADMIN_NAME")?.trim() || "平台管理员",
        passwordHash: this.security.hashPassword(seedAdminPassword),
        role: "admin",
        status: "active",
      },
    });

    const seedCredits = Number(this.config.get<string>("SEED_ADMIN_CREDITS") || 1000);
    if (seedCredits > 0) {
      await this.prisma.walletEntry.create({
        data: {
          userId: admin.id,
          amount: seedCredits,
          reason: "seed",
          refId: "seed-admin",
          actorId: admin.id,
        },
      });
    }
  }

  async validateSession(cookie?: string) {
    const session = this.security.readSession(cookie);
    if (!session) throw new UnauthorizedException({ error: "UNAUTHENTICATED", message: "请先登录" });
    const user = await this.prisma.user.findUnique({ where: { id: session.userId } });
    if (!user || user.status !== "active") throw new UnauthorizedException({ error: "UNAUTHENTICATED", message: "账号不可用" });
    return user;
  }

  async validateApiKey(token: string, requiredScope?: string) {
    if (!token) throw new UnauthorizedException({ error: "UNAUTHENTICATED", message: "缺少 API Key" });
    const apiKey = await this.prisma.apiKey.findUnique({ where: { keyHash: this.security.hashApiKey(token) } });
    if (!apiKey || apiKey.status !== "active") throw new UnauthorizedException({ error: "UNAUTHENTICATED", message: "API Key 不可用" });
    if (apiKey.expiresAt && apiKey.expiresAt.getTime() < Date.now()) throw new UnauthorizedException({ error: "UNAUTHENTICATED", message: "API Key 已过期" });
    if (requiredScope && !apiKey.scopes.includes(requiredScope)) throw new ForbiddenException({ error: "FORBIDDEN", message: "API Key 权限不足" });
    const user = await this.prisma.user.findUnique({ where: { id: apiKey.userId } });
    if (!user || user.status !== "active") throw new UnauthorizedException({ error: "UNAUTHENTICATED", message: "账号不可用" });
    await this.touchApiKey(apiKey);
    return { apiKey, user };
  }

  async publicUser(user: User) {
    const { passwordHash, ...rest } = user;
    return { ...rest, credits: await this.prisma.walletBalance(user.id) };
  }

  publicApiKey(apiKey: ApiKey) {
    const { keyHash, ...rest } = apiKey;
    return rest;
  }

  setSessionCookie(res: Response, userId: string) {
    res.cookie("session", this.security.createSession(userId), {
      httpOnly: true,
      sameSite: "lax",
      secure: this.config.get<string>("NODE_ENV") === "production",
      maxAge: this.security.sessionTtlMs,
    });
  }

  private async touchApiKey(apiKey: ApiKey) {
    const intervalMs = Number(this.config.get<string>("API_KEY_LAST_USED_WRITE_INTERVAL_MS") || 300000);
    const last = apiKey.lastUsedAt?.getTime() || 0;
    if (intervalMs === 0 || Date.now() - last >= intervalMs) {
      await this.prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } });
    }
  }
}
