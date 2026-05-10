import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { AuthService } from "../auth.service.js";
import { AuthedRequest } from "../../../common/http-types.js";

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const authorization = String(request.headers.authorization || "");
    const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const token = String(request.headers["x-api-key"] || bearer || "").trim();
    const { apiKey, user } = await this.auth.validateApiKey(token, "images.generate");
    request.apiKey = apiKey;
    request.user = user;
    return true;
  }
}
