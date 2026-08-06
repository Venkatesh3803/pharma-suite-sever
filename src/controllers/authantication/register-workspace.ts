import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import bcrypt from "bcrypt";
import { AppError } from "../../utils/app-errors";
import { User, Workspace } from "../../models/meta";
import { generateAccessToken, generateRefreshToken } from "../../utils/jwt";

const REFRESH_COOKIE_NAME = "refreshToken";
const REFRESH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // keep in sync with REFRESH_TOKEN_EXPIRY

const isStrongPassword = (password: unknown): password is string =>
  typeof password === "string" &&
  password.length >= 8 &&
  /[A-Za-z]/.test(password) &&
  /[0-9]/.test(password);

/**
 * Creates a new workspace and its Owner/admin user in a single request, then
 * logs the admin in immediately by issuing an access token (returned in the
 * response body) and a refresh token (set as an httpOnly cookie).
 *
 * Expects:
 * {
 *   workspace: { workspaceCode, name, type, phone, drugLicenseNumber, gstinOrTaxId?, address },
 *   admin: { fullName, email, password }
 * }
 */
export const registerWorkspace = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { workspace: workspaceInput, admin } = req.body;

    if (!workspaceInput || !admin) {
      throw new AppError("Missing workspace or admin account details.", 400);
    }

    const {
      workspaceCode,
      name,
      type,
      phone,
      drugLicenseNumber,
      gstinOrTaxId,
      address,
    } = workspaceInput;

    const { fullName, email, password } = admin;

    if (!workspaceCode || !name || !drugLicenseNumber || !phone) {
      throw new AppError(
        "Please provide all required workspace fields (Workspace Code, Name, Drug License, Phone).",
        400,
      );
    }

    if (!fullName || !email || !password) {
      throw new AppError(
        "Please provide the admin's full name, email, and password.",
        400,
      );
    }

    if (!isStrongPassword(password)) {
      throw new AppError(
        "Password must be at least 8 characters and include both letters and numbers.",
        400,
      );
    }

    const normalizedEmail = String(email).toLowerCase().trim();

    // 1. Check for duplicate workspace code or drug license
    const existingWorkspace = await Workspace.findOne({
      $or: [
        { workspaceCode: workspaceCode.toUpperCase() },
        { drugLicenseNumber },
      ],
    }).session(session);

    if (existingWorkspace) {
      throw new AppError(
        "Workspace code or Drug License Number already exists.",
        409,
      );
    }

    const existingUser = await User.findOne({
      $or: [{ email: normalizedEmail }, { phone }],
    }).session(session);

    if (existingUser) {
      throw new AppError(
        "An account with this email or phone number already exists.",
        409,
      );
    }

    // 2. Pre-generate Workspace ID
    const workspaceId = new mongoose.Types.ObjectId();

    // 3. Hash the admin's actual chosen password (12 rounds — a bit stronger
    // than the default 10, still fast enough for interactive login).
    const hashedPassword = await bcrypt.hash(password, 12);

    // 4. Create Admin / Owner User
    const newAdminUser = new User({
      fullName,
      email: normalizedEmail,
      phone,
      password: hashedPassword,
      workspace: workspaceId,
      role: "Owner",
      isAdmin: true,
      isEmailVerified: false,
      isPhoneVerified: false,
      status: "Active",
      authProvider: "password",
    });

    const savedUser = await newAdminUser.save({ session });

    // 5. Create Workspace
    const newWorkspace = new Workspace({
      _id: workspaceId,
      workspaceCode: workspaceCode.toUpperCase(),
      name,
      displayName: name,
      type: type || "SinglePharmacy",
      phone,
      email: normalizedEmail,
      drugLicenseNumber,
      gstinOrTaxId: gstinOrTaxId || undefined,
      adminUser: savedUser._id,
      users: [savedUser._id],
      address: {
        state: address?.state || "Telangana",
        country: address?.country || "India",
        street: address?.street || "",
        city: address?.city || "",
        zipCode: address?.zipCode || "",
      },
      status: "Active",
    });

    const savedWorkspace = await newWorkspace.save({ session });

    // 6. Issue tokens now that the account exists.
    const tokenPayload = {
      userId: savedUser._id.toString(),
      workspaceId: savedWorkspace._id.toString(),
      role: savedUser.role,
    };
    const accessToken = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken(tokenPayload);

    // Store a hash of the refresh token (never the raw token) so /refresh
    // and /logout can validate and revoke it later.
    savedUser.refreshTokenHash = await bcrypt.hash(refreshToken, 10);
    await savedUser.save({ session });

    await session.commitTransaction();
    session.endSession();

    res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: REFRESH_COOKIE_MAX_AGE_MS,
      path: "/api/auth",
    });

    return res.status(201).json({
      success: true,
      message: "Workspace and Admin User created successfully.",
      data: {
        workspace: savedWorkspace,
        user: {
          id: savedUser._id,
          fullName: savedUser.fullName,
          email: savedUser.email,
          role: savedUser.role,
          workspace: savedWorkspace._id,
        },
        accessToken,
      },
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    next(error);
  }
};
