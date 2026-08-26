import jwt from "jsonwebtoken";
import { config } from "../config";

export interface TokenPayload {
  userId: string;
  organizationId: string;
  branchId?: string;
  role: string;
}

export function signAccessToken(payload: TokenPayload): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: "1h" });
}

export function signRefreshToken(payload: TokenPayload): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: "7d" });
}

export function verifyToken<T extends object>(token: string): T {
  return jwt.verify(token, config.jwtSecret) as T;
}