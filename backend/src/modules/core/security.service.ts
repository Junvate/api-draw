import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

type SessionPayload = {
  userId: string;
  sid: string;
  expiresAt: number;
  nonce: string;
};

@Injectable()
export class SecurityService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  hashPassword(password: string) {
    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(password, salt, 64).toString("hex");
    return `${salt}:${hash}`;
  }

  verifyPassword(password: string, stored: string) {
    const [salt, hash] = stored.split(":");
    if (!salt || !hash) return false;
    const candidate = scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, "hex");
    return expected.length === candidate.length && timingSafeEqual(expected, candidate);
  }

  createApiKey() {
    const token = `draw_${randomBytes(32).toString("base64url")}`;
    return {
      token,
      prefix: token.slice(0, 14),
      keyHash: this.hashApiKey(token),
    };
  }

  hashApiKey(token: string) {
    return createHash("sha256").update(String(token || "")).digest("hex");
  }

  createSession(userId: string) {
    const payload = Buffer.from(JSON.stringify({
      userId,
      sid: randomBytes(16).toString("hex"),
      expiresAt: Date.now() + this.sessionTtlMs,
      nonce: randomBytes(16).toString("hex"),
    } satisfies SessionPayload)).toString("base64url");
    return `${payload}.${this.sign(payload)}`;
  }

  readSession(cookieValue?: string): SessionPayload | null {
    if (!cookieValue) return null;
    const [payload, signature] = cookieValue.split(".");
    if (!payload || !signature || !this.safeEqual(signature, this.sign(payload))) return null;
    try {
      const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionPayload;
      if (!session.userId || !session.sid || session.expiresAt < Date.now()) return null;
      return session;
    } catch {
      return null;
    }
  }

  get sessionTtlMs() {
    return Number(this.config.get<string>("SESSION_TTL_MS") || 1000 * 60 * 60 * 24 * 7);
  }

  encryptSecret(value: string) {
    const key = this.secretKey;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(String(value || ""), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
  }

  decryptSecret(payload?: string | null) {
    if (!payload) return null;
    const key = this.secretKey;
    const [ivRaw, tagRaw, dataRaw] = String(payload).split(".");
    if (!ivRaw || !tagRaw || !dataRaw) return null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"));
      decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(dataRaw, "base64url")),
        decipher.final(),
      ]);
      return decrypted.toString("utf8");
    } catch {
      return null;
    }
  }

  maskSecret(value?: string | null, keep = 4) {
    const text = String(value || "");
    if (!text) return "";
    if (text.length <= keep * 2) return `${text.slice(0, keep)}****`;
    return `${text.slice(0, keep)}****${text.slice(-keep)}`;
  }

  private sign(value: string) {
    return createHmac("sha256", this.config.get<string>("SESSION_SECRET") || "dev-session-secret-change-me").update(value).digest("hex");
  }

  private get secretKey() {
    return createHash("sha256")
      .update(this.config.get<string>("SESSION_SECRET") || "dev-session-secret-change-me")
      .digest();
  }

  private safeEqual(a: string, b: string) {
    const left = Buffer.from(String(a || ""));
    const right = Buffer.from(String(b || ""));
    return left.length === right.length && timingSafeEqual(left, right);
  }
}
