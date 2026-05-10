import { randomInt, randomUUID } from "node:crypto";
import { Inject, Injectable, BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

type CaptchaRecord = {
  code: string;
  expiresAt: number;
};

@Injectable()
export class CaptchaService {
  private readonly records = new Map<string, CaptchaRecord>();

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  create() {
    this.prune();
    const id = randomUUID().replaceAll("-", "");
    const code = String(randomInt(0, 10_000)).padStart(4, "0");
    const ttlSeconds = Math.max(60, Number(this.config.get<string>("REGISTER_CAPTCHA_TTL_SECONDS") || 300));
    this.records.set(id, { code, expiresAt: Date.now() + ttlSeconds * 1000 });
    return {
      id,
      image: `data:image/svg+xml;base64,${Buffer.from(this.render(code), "utf8").toString("base64")}`,
    };
  }

  verify(id: string, code: string) {
    const normalizedId = String(id || "").trim();
    const normalizedCode = String(code || "").trim();
    if (!/^\d{4}$/.test(normalizedCode) || !normalizedId) {
      throw new BadRequestException({ error: "CAPTCHA_INVALID", message: "验证码错误" });
    }
    const record = this.records.get(normalizedId);
    this.records.delete(normalizedId);
    if (!record || record.expiresAt < Date.now() || record.code !== normalizedCode) {
      throw new BadRequestException({ error: "CAPTCHA_INVALID", message: "验证码错误或已过期" });
    }
  }

  private prune() {
    const now = Date.now();
    for (const [id, record] of this.records) {
      if (record.expiresAt < now) this.records.delete(id);
    }
  }

  private render(code: string) {
    const chars = code.split("").map((digit, index) => {
      const x = 15 + index * 22;
      const rotate = [-9, 6, -4, 8][index] || 0;
      return `<text x="${x}" y="26" rotate="${rotate}">${digit}</text>`;
    }).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="104" height="36" viewBox="0 0 104 36">
      <rect width="104" height="36" rx="6" fill="#f7f9fb"/>
      <path d="M5 28 C24 6 39 34 57 12 S84 30 99 7" fill="none" stroke="#b9c4d2" stroke-width="1.4"/>
      <path d="M8 9 L96 27 M14 31 L89 5" stroke="#d8e0ea" stroke-width="1"/>
      <g font-family="Arial, sans-serif" font-size="24" font-weight="700" fill="#1b344f">${chars}</g>
    </svg>`;
  }
}
