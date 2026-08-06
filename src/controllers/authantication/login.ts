import type { NextFunction, Request, Response } from "express";
import bcrypt from "bcrypt";
import { AppError } from "../../utils/app-errors";
import { User } from "../../models/meta";
import { generateAccessToken, generateRefreshToken } from "../../utils/jwt";

const REFRESH_COOKIE_NAME = "refreshToken";
const REFRESH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const login = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      throw new AppError("Email and password are required.", 400);
    }

    // Your User schema should mark `password` as `select: false` by default —
    // this explicit .select("+password") is what opts back in for this check.
    const user = await User.findOne({
      email: String(email).toLowerCase().trim(),
    }).select("+password");

    // Deliberately identical error for "no such user" and "wrong password"
    // so a caller can't use this endpoint to enumerate registered emails.
    if (!user) {
      throw new AppError("Invalid email or password.", 401);
    }

    const passwordMatches = await bcrypt.compare(password, user.password);
    if (!passwordMatches) {
      throw new AppError("Invalid email or password.", 401);
    }

    if (user.status !== "Active") {
      throw new AppError(
        "This account is not active. Contact your workspace admin.",
        403,
      );
    }

    const tokenPayload = {
      userId: user._id.toString(),
      workspaceId: user.workspace.toString(),
      role: user.role,
    };
    const accessToken = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken(tokenPayload);

    user.refreshTokenHash = await bcrypt.hash(refreshToken, 10);
    await user.save();

    res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: REFRESH_COOKIE_MAX_AGE_MS,
      path: "/api/auth",
    });

    return res.status(200).json({
      success: true,
      data: {
        user: {
          id: user._id,
          fullName: user.fullName,
          email: user.email,
          role: user.role,
          workspace: user.workspace,
        },
        accessToken,
      },
    });
  } catch (error) {
    next(error);
  }
};
