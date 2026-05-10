import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, Post, Req, Res, UnauthorizedException } from "@nestjs/common";
import { Response } from "express";
import { PrismaService } from "../core/prisma.service.js";
import { SecurityService } from "../core/security.service.js";
import { AuthedRequest } from "../../common/http-types.js";
import { AuthService } from "./auth.service.js";
import { CaptchaService } from "./captcha.service.js";
import { LoginDto, RegisterDto } from "./dto.js";

@Controller("api")
export class AuthController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SecurityService) private readonly security: SecurityService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(CaptchaService) private readonly captcha: CaptchaService,
  ) {}

  @Get("auth/captcha")
  captchaImage() {
    return this.captcha.create();
  }

  @Post("auth/register")
  async register(@Body() body: RegisterDto, @Res({ passthrough: true }) res: Response) {
    const email = body.email.trim().toLowerCase();
    if (body.password !== body.passwordConfirm) {
      throw new BadRequestException({ error: "PASSWORD_CONFIRM_MISMATCH", message: "两次输入的密码不一致" });
    }
    this.captcha.verify(body.captchaId, body.captchaCode);
    const exists = await this.prisma.user.findUnique({ where: { email } });
    if (exists) throw new ConflictException({ error: "EMAIL_EXISTS", message: "邮箱已注册" });
    const user = await this.prisma.user.create({
      data: {
        email,
        name: body.name || email.split("@")[0],
        passwordHash: this.security.hashPassword(body.password),
        role: "user",
        status: "active",
        walletEntries: { create: { amount: 20, reason: "signup_bonus", refId: "signup" } },
      },
    });
    this.auth.setSessionCookie(res, user.id);
    return { user: await this.auth.publicUser(user) };
  }

  @Post("auth/login")
  async login(@Body() body: LoginDto, @Res({ passthrough: true }) res: Response) {
    const email = body.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !this.security.verifyPassword(body.password, user.passwordHash)) {
      throw new UnauthorizedException({ error: "BAD_CREDENTIALS", message: "邮箱或密码错误" });
    }
    if (user.status !== "active") throw new ForbiddenException({ error: "ACCOUNT_DISABLED", message: "账号已停用，请联系管理员" });
    this.auth.setSessionCookie(res, user.id);
    return { user: await this.auth.publicUser(user) };
  }

  @Post("auth/logout")
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie("session");
    return { ok: true };
  }

  @Get("me")
  async me(@Req() req: AuthedRequest) {
    try {
      const user = await this.auth.validateSession(req.cookies?.session);
      return { user: await this.auth.publicUser(user) };
    } catch {
      return { user: null };
    }
  }
}
