import { Request } from "express";
import { ApiKey, User } from "@prisma/client";

export type AuthedRequest = Request & {
  user?: User;
  apiKey?: ApiKey;
};
