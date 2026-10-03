import { BrevoClient } from "@getbrevo/brevo";
import { config } from "../../config/index.js";

let client: BrevoClient | null = null;

export interface BrevoSendEmailInput {
  to: { email: string; name?: string };
  subject: string;
  htmlContent: string;
  textContent: string;
}

export interface BrevoEmailResult {
  sent: true;
  channel: "brevo";
}

function getClient(): BrevoClient | null {
  if (!config.brevoApiKey) return null;
  if (!client) {
    client = new BrevoClient({ apiKey: config.brevoApiKey });
  }
  return client;
}

export async function brevoSendEmail(input: BrevoSendEmailInput): Promise<BrevoEmailResult> {
  const c = getClient();
  if (!c) {
    throw new Error("Brevo is not configured (BREVO_API_KEY is empty).");
  }

  await c.transactionalEmails.sendTransacEmail({
    subject: input.subject,
    htmlContent: input.htmlContent,
    textContent: input.textContent,
    sender: { name: config.mailFromName, email: config.mailFromEmail },
    to: [{ email: input.to.email, name: input.to.name }],
  });

  return { sent: true, channel: "brevo" };
}
