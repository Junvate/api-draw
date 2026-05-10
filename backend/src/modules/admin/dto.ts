import { Transform, Type } from "class-transformer";
import { IsBoolean, IsEmail, IsIn, IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min, MinLength } from "class-validator";

export class AdminCreateUserDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(256)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsIn(["active", "disabled"])
  status?: "active" | "disabled";

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000000)
  credits?: number;
}

export class PatchUserDto {
  @IsOptional()
  @IsIn(["active", "disabled"])
  status?: "active" | "disabled";
}

export class CreditsDto {
  @IsString()
  userId!: string;

  @IsInt()
  @Min(-1000000)
  @Max(1000000)
  amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  reason?: string;
}

export class GatewayDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsIn(["openai"])
  provider?: "openai";

  @IsOptional()
  @IsString()
  @MaxLength(500)
  baseUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  healthCheckPath?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  generationPath?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  upstreamGroup?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  apiKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  model?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100000)
  costCredits?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  @Max(600000)
  timeoutMs?: number;

  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-100000)
  @Max(100000)
  priority?: number;
}

export class PatchGatewayDto extends GatewayDto {
  @IsOptional()
  declare name: string;

  @IsOptional()
  @IsIn(["unknown", "healthy", "degraded", "down"])
  healthStatus?: "unknown" | "healthy" | "degraded" | "down";

  @IsOptional()
  @IsInt()
  @Min(0)
  consecutiveFailures?: number;
}

export class RedemptionCodeDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  code?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000000)
  credits?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000000)
  maxUses?: number;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}

export class PatchRedemptionCodeDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000000)
  credits?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000000)
  maxUses?: number;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  active?: boolean;
}
