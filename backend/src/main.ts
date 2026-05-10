import "reflect-metadata";
import compression from "compression";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./modules/app.module.js";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false });
  const trustProxy = Number(process.env.TRUST_PROXY || 0);
  if (trustProxy > 0) app.set("trust proxy", trustProxy);

  app.disable("x-powered-by");
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(compression());
  app.use(cookieParser());

  // Global API rate limit: 600 req/min per IP (burst-friendly for polling)
  app.use("/api", rateLimit({
    windowMs: 60_000,
    max: Number(process.env.GENERATION_IP_RPM || 600),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "RATE_LIMITED", message: "请求过于频繁，请稍后再试" },
  }));

  // Tighter limit on generation endpoint: 30 req/min per IP
  app.use("/api/generate", rateLimit({
    windowMs: 60_000,
    max: Number(process.env.GENERATION_IP_RPM || 30),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "RATE_LIMITED", message: "生成请求过于频繁，请稍后再试" },
  }));

  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidUnknownValues: true,
  }));

  const port = Number(process.env.PORT || 4173);
  await app.listen(port, "0.0.0.0");
  console.log(`GPT Image API platform running at http://127.0.0.1:${port}`);
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});

