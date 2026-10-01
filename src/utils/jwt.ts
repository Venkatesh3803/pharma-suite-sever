import jwt from "jsonwebtoken";
import { randomBytes } from "node:crypto";
import { config } from "../config";

export interface TokenPayload {
  userId: string;
  organizationId: string;
  branchId?: string;
  role: string;
  tv: number;
  typ?: "access" | "refresh";
}

export function signAccessToken(payload: TokenPayload): string {
  const { typ: _ignored, ...rest } = payload;
  return jwt.sign({ ...rest, typ: "access" }, config.jwtAccessSecret, { expiresIn: "1h" });
}

export function signRefreshToken(payload: TokenPayload): string {
  const { typ: _ignored, ...rest } = payload;
  // Unique per mint: `iat` only has 1s resolution, so two rapid rotations
  // would otherwise produce byte-identical tokens and defeat reuse detection.
  return jwt.sign({ ...rest, typ: "refresh", jti: randomBytes(16).toString("hex") }, config.jwtRefreshSecret, { expiresIn: "7d" });
}

function assertTokenType(decoded: TokenPayload, expected: "access" | "refresh"): void {
  // Tokens minted before the `typ` claim was added are rejected on refresh
  // (forces re-login once) but still accepted as access tokens until expiry.
  if (!decoded.typ) {
    if (expected === "refresh") throw new Error("legacy token without type");
    return;
  }
  if (decoded.typ !== expected) throw new Error(`wrong token type: expected ${expected}`);
}

export function verifyAccessToken<T extends object>(token: string): T {
  const decoded = jwt.verify(token, config.jwtAccessSecret) as TokenPayload & T;
  assertTokenType(decoded, "access");
  return decoded as T;
}

export function verifyRefreshToken<T extends object>(token: string): T {
  const decoded = jwt.verify(token, config.jwtRefreshSecret) as TokenPayload & T;
  assertTokenType(decoded, "refresh");
  return decoded as T;
}

export function verifyToken<T extends object>(token: string): T {
  // Legacy helper: try access secret first, then refresh secret.
  // Kept for backward compatibility; new code must use the typed verifiers.
  try {
    return verifyAccessToken<T>(token);
  } catch {
    return verifyRefreshToken<T>(token);
  }
}