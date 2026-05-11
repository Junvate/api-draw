import { Transform } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from "class-validator";

export class CreateImageDto {
  @IsString()
  @MinLength(4)
  @MaxLength(8000)
  prompt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  model?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  ratio?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  size?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  quality?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  output_format?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  background?: string;

  @IsOptional()
  @Transform(({ value }) => value === undefined || value === "" ? undefined : Number(value))
  @IsInt()
  @Min(0)
  @Max(3)
  refs?: number;

  @IsOptional()
  @Transform(({ value }) => value === undefined || value === "" ? undefined : Number(value))
  @IsInt()
  @Min(1)
  @Max(4)
  count?: number;

  @IsOptional()
  @IsIn(["sync", "async"])
  response_mode?: "sync" | "async";
}
