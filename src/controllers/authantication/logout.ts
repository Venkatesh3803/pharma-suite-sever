import type { NextFunction, Request, Response } from "express";
import { User } from "../../models/meta";

const REFRESH_COOKIE_NAME = "refreshToken";

export const logout = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user?.userId;
    if (userId) {
      await User.findByIdAndUpdate(userId, { $unset: { refreshTokenHash: 1 } });
    }
    res.clearCookie(REFRESH_COOKIE_NAME, { path: "/api/auth" });
    return res.status(200).json({ success: true, message: "Logged out." });
  } catch (error) {
    next(error);
  }
};
