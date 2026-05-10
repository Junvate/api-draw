import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { AuthedRequest } from "../../../common/http-types.js";

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    if (request.user?.role !== "admin") throw new ForbiddenException({ error: "FORBIDDEN", message: "需要管理员权限" });
    return true;
  }
}
