import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import {
    loginValidator,
    registerValidator,
    refreshValidator,
    forgotPasswordValidator,
    verifyOtpValidator,
    resetPasswordValidator
} from "../validators/auth.validator.js";
import { validateBody } from "../middleware/validate.js";
import { authenticate } from "../middleware/auth.js";
import { verifyCookieRequestOrigin } from "../middleware/origin-check.js";
import * as ctrl from "../controllers/auth.controller.js";

const forgotPasswordLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
        res.status(429).json({
            success: false,
            data: null,
            message: "Too many requests. Please try again later.",
            code: "TOO_MANY_REQUESTS"
        });
    }
});

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
        res.status(429).json({
            success: false,
            data: null,
            message: "Too many login attempts. Please try again later.",
            code: "TOO_MANY_REQUESTS"
        });
    }
});

const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
        res.status(429).json({
            success: false,
            data: null,
            message: "Too many registration attempts. Please try again later.",
            code: "TOO_MANY_REQUESTS"
        });
    }
});

const verifyOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      data: null,
      message: "Too many requests. Please try again later.",
      code: "TOO_MANY_REQUESTS"
    });
  }
});

const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      data: null,
      message: "Too many requests. Please try again later.",
      code: "TOO_MANY_REQUESTS"
    });
  }
});

const router = Router();

router.post("/login", loginLimiter, verifyCookieRequestOrigin, validateBody(loginValidator), ctrl.login);
router.post("/refresh", verifyCookieRequestOrigin, validateBody(refreshValidator), ctrl.refresh);
router.post("/logout", authenticate, verifyCookieRequestOrigin, ctrl.logout);
router.get("/me", authenticate, ctrl.me);
router.post("/register", registerLimiter, verifyCookieRequestOrigin, validateBody(registerValidator), ctrl.register);
router.post("/forgot-password", forgotPasswordLimiter, verifyCookieRequestOrigin, validateBody(forgotPasswordValidator), ctrl.forgotPassword);
router.post("/verify-otp", verifyOtpLimiter, verifyCookieRequestOrigin, validateBody(verifyOtpValidator), ctrl.verifyOtp);
router.post("/reset-password", resetPasswordLimiter, verifyCookieRequestOrigin, validateBody(resetPasswordValidator), ctrl.resetPassword);

export default router;
