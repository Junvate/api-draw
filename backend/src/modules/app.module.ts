import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { BullModule } from "@nestjs/bullmq";
import { ServeStaticModule } from "@nestjs/serve-static";
import { join } from "node:path";
import { AdminModule } from "./admin/admin.module.js";
import { ApiModule } from "./api/api.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { CoreModule } from "./core/core.module.js";
import { ImageModule } from "./image/image.module.js";
import { OperationsModule } from "./operations/operations.module.js";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>("REDIS_HOST") || new URL(config.get<string>("REDIS_URL") || "redis://127.0.0.1:6379").hostname,
          port: Number(config.get<string>("REDIS_PORT") || new URL(config.get<string>("REDIS_URL") || "redis://127.0.0.1:6379").port || 6379),
          password: new URL(config.get<string>("REDIS_URL") || "redis://127.0.0.1:6379").password || undefined,
          maxRetriesPerRequest: null,
        },
        prefix: config.get<string>("REDIS_KEY_PREFIX") || "draw",
      }),
    }),
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), "public"),
      serveRoot: "/",
      exclude: ["/api/(.*)", "/admin", "/admin/(.*)", "/workspace", "/workspace/(.*)"],
    }),
    CoreModule,
    AuthModule,
    ImageModule,
    ApiModule,
    AdminModule,
    OperationsModule,
  ],
})
export class AppModule {}
