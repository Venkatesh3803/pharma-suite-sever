import jwt from "jsonwebtoken";

const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET as string;
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET as string;
const ACCESS_TOKEN_EXPIRY = process.env.ACCESS_TOKEN_EXPIRY || "15m";
const REFRESH_TOKEN_EXPIRY = process.env.REFRESH_TOKEN_EXPIRY || "7d";

console.log(
  "ACCESS_TOKEN_SECRET",
  ACCESS_TOKEN_SECRET,
  "REFRESH_TOKEN_SECRET",
  REFRESH_TOKEN_SECRET,
);

if (!ACCESS_TOKEN_SECRET || !REFRESH_TOKEN_SECRET) {
  // Fail fast at boot rather than silently signing tokens with `undefined`.
  throw new Error(
    "ACCESS_TOKEN_SECRET and REFRESH_TOKEN_SECRET must be set in the environment. " +
      "Generate strong random values, e.g. `openssl rand -hex 64`.",
  );
}

export interface TokenPayload {
  userId: string;
  workspaceId: string;
  role: string;
}

export const generateAccessToken = (payload: TokenPayload): string =>
  jwt.sign(payload, ACCESS_TOKEN_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });

export const generateRefreshToken = (payload: TokenPayload): string =>
  jwt.sign(payload, REFRESH_TOKEN_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRY });

export const verifyAccessToken = (token: string): TokenPayload =>
  jwt.verify(token, ACCESS_TOKEN_SECRET) as TokenPayload;

export const verifyRefreshToken = (token: string): TokenPayload =>
  jwt.verify(token, REFRESH_TOKEN_SECRET) as TokenPayload;
