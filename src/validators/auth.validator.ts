import { z } from "zod";

const passwordPolicy = z
  .string()
  .min(8, "Password must be at least 8 characters and include both letters and numbers.")
  .regex(/^(?=.*[A-Za-z])(?=.*\d)/, "Password must be at least 8 characters and include both letters and numbers.");

export const loginValidator = z.object({
  username: z.string().min(1),
  // Deliberately no complexity rule here: policy applies to *new* passwords,
  // and rejecting old-but-valid credentials at login would lock users out.
  password: z.string().min(1),
});

export const registerValidator = z
  .object({
    fullName: z.string().min(1),
    email: z.string().email(),
    password: passwordPolicy,
    // Optional for backward compat (older clients check the match locally).
    confirmPassword: z.string().optional(),
    phone: z.string().optional(),
    workspaceName: z.string().min(1),
    workspaceCode: z.string().min(2).max(12),
    gstin: z.string().optional(),
    address: z.string().optional(),
    state: z.string().optional(),
  })
  .refine(data => !data.confirmPassword || data.password === data.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
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
    resetToken: z.string().min(1).optional(),
    newPassword: z
      .string()
      .min(8, "Password must be at least 8 characters and include both letters and numbers.")
      .regex(/^(?=.*[A-Za-z])(?=.*\d)/, "Password must be at least 8 characters and include both letters and numbers.")
      .refine(value => value.trim().length > 0, "Password cannot be only whitespace"),
    confirmPassword: z.string().min(8, "Password must be at least 8 characters"),
  })
  .refine(data => data.newPassword === data.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });