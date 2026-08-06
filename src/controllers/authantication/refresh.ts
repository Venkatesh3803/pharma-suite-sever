import type { NextFunction, Request, Response } from "express";
import bcrypt from "bcrypt";
import { AppError } from "../../utils/app-errors";
import { User } from "../../models/meta";
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
} from "../../utils/jwt";

const REFRESH_COOKIE_NAME = "refreshToken";
const REFRESH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const refresh = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const incomingToken = req.cookies?.[REFRESH_COOKIE_NAME];
    if (!incomingToken) {
      throw new AppError("No refresh token provided.", 401);
    }

    let payload;
    try {
      payload = verifyRefreshToken(incomingToken);
    } catch {
      throw new AppError(
        "Refresh token is invalid or expired. Please log in again.",
        401,
      );
    }

    const user = await User.findById(payload.userId).select(
      "+refreshTokenHash",
    );
    if (!user || !user.refreshTokenHash) {
      throw new AppError("Session no longer valid. Please log in again.", 401);
    }

    const tokenMatches = await bcrypt.compare(
      incomingToken,
      user.refreshTokenHash,
    );
    if (!tokenMatches) {
      // The presented token doesn't match what we last issued — could be a
      // stale/rotated token or theft. Invalidate the stored one defensively
      // so a leaked old token can't be replayed.
      user.refreshTokenHash = undefined;
      await user.save();
      throw new AppError("Session no longer valid. Please log in again.", 401);
    }

    // Rotate on every use: issue a brand new pair, discard the old one.
    const tokenPayload = {
      userId: user._id.toString(),
      workspaceId: user.workspace.toString(),
      role: user.role,
    };
    const newAccessToken = generateAccessToken(tokenPayload);
    const newRefreshToken = generateRefreshToken(tokenPayload);

    user.refreshTokenHash = await bcrypt.hash(newRefreshToken, 10);
    await user.save();

    res.cookie(REFRESH_COOKIE_NAME, newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: REFRESH_COOKIE_MAX_AGE_MS,
      path: "/api/auth",
    });

    return res.status(200).json({
      success: true,
      data: { accessToken: newAccessToken },
    });
  } catch (error) {
    next(error);
  }
};
