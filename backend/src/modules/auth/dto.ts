import { IsEmail, IsOptional, IsString, Length, MaxLength, MinLength } from "class-validator";

export class RegisterDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(256)
  password!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(256)
  passwordConfirm!: string;

  @IsString()
  @MaxLength(80)
  captchaId!: string;

  @IsString()
  @Length(4, 4)
  captchaCode!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;
}

export class LoginDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(256)
  password!: string;
}
