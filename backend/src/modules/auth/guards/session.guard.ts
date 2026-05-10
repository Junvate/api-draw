import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { AuthService } from "../auth.service.js";
import { AuthedRequest } from "../../../common/http-types.js";

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    request.user = await this.auth.validateSession(request.cookies?.session);
    return true;
  }
}
