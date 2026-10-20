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
const accepted = z.object({
  request_id: z.string().min(1),
  data: z.array(z.object({ code: z.literal("EM_104") })).min(1),
});
const rejected = z.object({
  data: z.object({ error_code: z.string().regex(/^[A-Z][A-Z0-9_]{1,50}$/) }),
  message: z.literal("error"),
});
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
function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.min(24 * 60 * 60_000, Math.max(1000, ms)) : undefined;
}
export function hasZohoLogCredentials(): boolean {
  return Boolean(
    env.ZOHO_EMAIL_AGENT_KEY &&
    env.ZOHO_OAUTH_CLIENT_ID &&
    env.ZOHO_OAUTH_CLIENT_SECRET &&
    env.ZOHO_OAUTH_REFRESH_TOKEN,
  );
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
      return { kind: "rejected", retryable: false, code: "ZOHO_MESSAGE_INVALID" };
    try {
      const response = await fetch(api, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Zoho-enczapikey ${env.ZOHO_EMAIL_API_KEY!}`,
          "content-type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          from,
          to: [{ email_address: { address: message.to } }],
          reply_to: [{ address: message.replyTo }],
          subject: message.subject,
          htmlbody: message.html,
          textbody: message.text,
          client_reference: clientReference,
          track_opens: false,
          track_clicks: false,
        }),
      });
      const body = await json(response);
      const success = accepted.safeParse(body);
      if (response.ok && success.success)
        return { kind: "accepted", messageId: success.data.request_id };
      const failure = rejected.safeParse(body);
      // Only explicit provider rejections establish that another send is safe.
      if (response.status >= 400 && response.status < 500 && failure.success)
        return {
          kind: "rejected",
          retryable: response.status === 429,
          code: `ZOHO_${failure.data.data.error_code}`,
          retryAfterMs: retryAfter(response.headers.get("retry-after")),
        };
      return { kind: "uncertain", code: "ZOHO_RESULT_UNCERTAIN" };
    } catch {
      return { kind: "uncertain", code: "ZOHO_REQUEST_UNCERTAIN" };
    }
  }
  async find(clientReference: string): Promise<{ messageId: string } | null> {
    if (!hasZohoLogCredentials()) throw new Error("ZOHO_LOGS_NOT_CONFIGURED");
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
