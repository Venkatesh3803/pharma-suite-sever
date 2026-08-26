import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import {
  loginValidator,
  registerValidator,
  refreshValidator,
  forgotPasswordValidator,
  verifyOtpValidator,
  resetPasswordValidator,
} from "../validators/auth.validator";
import { validateBody } from "../middleware/validate";
import { authenticate } from "../middleware/auth";
import * as ctrl from "../controllers/auth.controller";

const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
});

const verifyOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

const router = Router();

router.post("/login", validateBody(loginValidator), ctrl.login);
router.post("/refresh", validateBody(refreshValidator), ctrl.refresh);
router.post("/logout", authenticate, ctrl.logout);
router.get("/me", authenticate, ctrl.me);
router.post("/register", validateBody(registerValidator), ctrl.register);
router.post(
  "/forgot-password",
  forgotPasswordLimiter,
  validateBody(forgotPasswordValidator),
  ctrl.forgotPassword,
);
router.post("/verify-otp", verifyOtpLimiter, validateBody(verifyOtpValidator), ctrl.verifyOtp);
router.post(
  "/reset-password",
  resetPasswordLimiter,
  validateBody(resetPasswordValidator),
  ctrl.resetPassword,
);

export default router;