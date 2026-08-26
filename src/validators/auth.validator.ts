import { z } from "zod";

export const loginValidator = z.object({
  username: z.string().min(1),
  password: z.string().min(6),
});

export const registerValidator = z.object({
  fullName: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
  phone: z.string().optional(),
  workspaceName: z.string().min(1),
  workspaceCode: z.string().min(2).max(12),
  gstin: z.string().optional(),
  address: z.string().optional(),
  state: z.string().optional(),
});

export const refreshValidator = z.object({}).passthrough();

export const forgotPasswordValidator = z.object({
  email: z.string().trim().email(),
});

export const verifyOtpValidator = z.object({
  email: z.string().trim().email(),
  otp: z.string().regex(/^\d{6}$/, "OTP must be 6 digits"),
});

export const resetPasswordValidator = z
  .object({
    resetToken: z.string().min(1),
    newPassword: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .refine(value => value.trim().length > 0, "Password cannot be only whitespace"),
    confirmPassword: z.string().min(8, "Password must be at least 8 characters"),
  })
  .refine(data => data.newPassword === data.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });