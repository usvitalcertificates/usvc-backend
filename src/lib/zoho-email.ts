import nodemailer from "nodemailer";
import { z } from "zod";
import { env } from "../config/env.js";

export type OutgoingEmail = {
  from: string;
  to: string;
  replyTo: string;
  subject: string;
  html: string;
  text: string;
};
export type SendResult =
  | { kind: "accepted"; messageId: string }
  | { kind: "rejected"; retryable: boolean; code: string; retryAfterMs?: number }
  | { kind: "uncertain"; code: string };
const address = z.string().email();
export function parseSender(value: string): { address: string; name?: string } {
  const named = value.match(/^([^<>\r\n]+)\s*<([^<>\r\n]+)>$/);
  if (named)
    return {
      address: address.parse(named[2].trim()),
      name: named[1].trim().replace(/^"(.*)"$/, "$1"),
    };
  return { address: address.parse(value.trim()) };
}
const api = "https://cpaas.zoho.in/v1.1/email";
const tokenUrl = "https://accounts.zoho.in/oauth/v2/token";
const logs = z.object({
  status: z.literal("success"),
  data: z.array(
    z.object({
      request_id: z.string().optional(),
      email_reference: z.string().optional(),
      mailagent_key: z.string(),
      client_reference: z.string().optional(),
    }),
  ),
});

async function json(response: Response): Promise<unknown> {
  // Provider payloads must never escape in exceptions or application logs.
  try {
    return await response.json();
  } catch {
    return null;
  }
}
export function smtpOptions() {
  return {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    requireTLS: true,
    auth: { user: env.SMTP_USER!, pass: env.SMTP_PASSWORD! },
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" as const },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    dnsTimeout: 10_000,
    logger: false as const,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}
export class ZohoEmailClient {
  private token?: { value: string; until: number };
  private refreshing?: Promise<string>;
  private async accessToken(): Promise<string> {
    if (this.token && this.token.until > Date.now()) return this.token.value;
    if (!this.refreshing)
      this.refreshing = (async () => {
        const response = await fetch(tokenUrl, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: env.ZOHO_OAUTH_CLIENT_ID!,
            client_secret: env.ZOHO_OAUTH_CLIENT_SECRET!,
            refresh_token: env.ZOHO_OAUTH_REFRESH_TOKEN!,
          }),
        });
        const result = z
          .object({ access_token: z.string().min(1), expires_in: z.coerce.number().positive() })
          .safeParse(await json(response));
        if (!response.ok || !result.success) throw new Error("ZOHO_OAUTH_UNAVAILABLE");
        this.token = {
          value: result.data.access_token,
          until: Date.now() + Math.max(1, result.data.expires_in - 60) * 1000,
        };
        return this.token.value;
      })().finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }
  async send(message: OutgoingEmail, clientReference: string): Promise<SendResult> {
    let from: ReturnType<typeof parseSender>;
    try {
      from = parseSender(message.from);
      address.parse(message.to);
      address.parse(message.replyTo);
    } catch {
      return { kind: "rejected", retryable: false, code: "EMAIL_ADDRESS_INVALID" };
    }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(clientReference) || /[\r\n]/.test(message.subject))
      return { kind: "rejected", retryable: false, code: "ZOHO_SMTP_MESSAGE_INVALID" };
    const transport = nodemailer.createTransport(smtpOptions());
    try {
      const info = await transport.sendMail({
        from: { address: from.address, name: from.name },
        to: { address: message.to },
        replyTo: { address: message.replyTo },
        subject: message.subject,
        html: message.html,
        text: message.text,
        messageId: `<${clientReference}@${from.address.split("@")[1]}>`,
        headers: { "X-TM-CLIENT-REF": clientReference },
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      if (info.accepted?.length === 1 && !info.rejected?.length && /^250\b/.test(info.response))
        return { kind: "accepted", messageId: info.messageId };
      return { kind: "uncertain", code: "ZOHO_SMTP_RESULT_UNCERTAIN" };
    } catch (error) {
      const parsed = z
        .object({ responseCode: z.number().int().min(400).max(599) })
        .safeParse(error);
      if (parsed.success)
        return {
          kind: "rejected",
          retryable: parsed.data.responseCode < 500,
          code: `ZOHO_SMTP_${parsed.data.responseCode}`,
        };
      // A lost final DATA reply can mean the message was already accepted.
      return { kind: "uncertain", code: "ZOHO_SMTP_REQUEST_UNCERTAIN" };
    } finally {
      transport.close();
    }
  }
  async find(clientReference: string): Promise<{ messageId: string } | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken();
      const url = new URL(api);
      url.search = new URLSearchParams({
        mailagent_key: env.ZOHO_EMAIL_AGENT_KEY!,
        client_reference: clientReference,
        limit: "100",
      }).toString();
      const response = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Zoho-oauthtoken ${token}`, Accept: "application/json" },
      });
      if (response.status === 401 && attempt === 0) {
        this.token = undefined;
        continue;
      }
      const result = logs.safeParse(await json(response));
      if (!response.ok || !result.success) throw new Error("ZOHO_LOGS_UNAVAILABLE");
      if (!result.data.data.length) return null;
      // Status may be queued/delivered/bounced: all prove prior acceptance, never resend.
      if (
        result.data.data.some(
          (row) =>
            row.mailagent_key !== env.ZOHO_EMAIL_AGENT_KEY ||
            (row.client_reference !== undefined && row.client_reference !== clientReference),
        )
      )
        throw new Error("ZOHO_LOG_REFERENCE_MISMATCH");
      const id = result.data.data[0].request_id || result.data.data[0].email_reference;
      if (!id) throw new Error("ZOHO_LOG_REFERENCE_MISSING");
      return { messageId: id };
    }
    throw new Error("ZOHO_LOGS_UNAVAILABLE");
  }
}
export const zohoEmail = new ZohoEmailClient();
