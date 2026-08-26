const SUBJECT = "Your PharmaSuite verification code";

function htmlContent(otp: string): string {
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;background:#F7F4EC;padding:24px;">
      <div style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #DED7C4;">
        <div style="background:#0E3B36;padding:16px 24px;">
          <span style="color:#C1652B;font-size:14px;font-weight:700;letter-spacing:2px;">PharmaSuite</span>
        </div>
        <div style="padding:24px;">
          <p style="margin:0 0 16px;color:#14201C;font-size:14px;line-height:1.6;">
            Hello,
          </p>
          <p style="margin:0 0 16px;color:#14201C;font-size:14px;line-height:1.6;">
            We received a request to reset your PharmaSuite password. Your verification code is:
          </p>
          <div style="background:#EFEADC;border:1px solid #DED7C4;padding:16px;text-align:center;letter-spacing:8px;font-size:26px;font-weight:700;color:#0E3B36;">
            ${otp}
          </div>
          <p style="margin:16px 0 0;color:#14201C;font-size:12px;line-height:1.6;">
            This code will expire in 10 minutes. If you did not request a password reset, you can safely
            ignore this email.
          </p>
          <p style="margin:16px 0 0;color:#14201C;font-size:12px;line-height:1.6;">
            For your security, never share this code with anyone.
          </p>
          <p style="margin:16px 0 0;color:#14201C;font-size:12px;line-height:1.6;">
            Regards,<br />
            PharmaSuite Team
          </p>
        </div>
      </div>
    </div>
  `;
}

function textContent(otp: string): string {
  return [
    "Hello,",
    "",
    "We received a request to reset your PharmaSuite password.",
    "",
    `Your verification code is: ${otp}`,
    "",
    "This code will expire in 10 minutes.",
    "If you did not request a password reset, you can safely ignore this email.",
    "",
    "For your security, never share this code with anyone.",
    "",
    "Regards,",
    "PharmaSuite Team",
  ].join("\n");
}

export const otpEmailTemplate = {
  subject: SUBJECT,
  htmlContent,
  textContent,
};
