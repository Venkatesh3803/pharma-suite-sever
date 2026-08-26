import { config } from "../../config";
import { brevoSendEmail } from "./brevo.service";
import { otpEmailTemplate } from "./templates/otp-email";
import { subscriptionNoticeTemplate } from "./templates/subscription-notice";

export interface SendOtpEmailInput {
    to: { email: string; name?: string };
    otp: string;
}

export interface SendOtpEmailResult {
    sent: boolean;
    channel: "brevo" | "console";
}

/**
 * Sends the password-reset OTP email through Brevo.
 *
 * When BREVO_API_KEY is not configured the request is treated as a
 * no-op so the caller can keep returning an enumeration-safe generic
 * response. The OTP is intentionally never logged and never returned.
 */
export async function sendOtpEmail(input: SendOtpEmailInput): Promise<SendOtpEmailResult> {
    if (!config.brevoApiKey) {
        console.log(`[MAIL:OTP] Verification code would be emailed to ${input.to.email} (Brevo not configured; set BREVO_API_KEY to send).`);
        return { sent: false, channel: "console" };
    }
    const respo = await brevoSendEmail({
        to: input.to,
        subject: otpEmailTemplate.subject,
        htmlContent: otpEmailTemplate.htmlContent(input.otp),
        textContent: otpEmailTemplate.textContent(input.otp)
    });
    console.log(respo);
    return { sent: true, channel: "brevo" };
}

export interface SendSubscriptionNoticeInput {
    to: { email: string; name?: string };
    title: string;
    body: string;
}

export interface SendSubscriptionNoticeResult {
    sent: boolean;
    channel: "brevo" | "console";
}

/**
 * Sends a transactional subscription notice (payment approved / rejected /
 * plan expiring). Falls back to a console log when Brevo is not configured so
 * the notification is never silently dropped in development.
 */
export async function sendSubscriptionNotice(
    input: SendSubscriptionNoticeInput
): Promise<SendSubscriptionNoticeResult> {
    if (!config.brevoApiKey) {
        console.log(`[MAIL:SUB] ${input.title} -> ${input.to.email} (Brevo not configured; set BREVO_API_KEY to send).`);
        return { sent: false, channel: "console" };
    }
    await brevoSendEmail({
        to: input.to,
        subject: subscriptionNoticeTemplate.subject,
        htmlContent: subscriptionNoticeTemplate.htmlContent(input.title, input.body),
        textContent: subscriptionNoticeTemplate.textContent(input.title, input.body)
    });
    return { sent: true, channel: "brevo" };
}
