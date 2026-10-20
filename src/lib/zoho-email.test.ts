import test from "node:test";
import assert from "node:assert/strict";
import nodemailer from "nodemailer";
import { ZohoEmailClient, parseSender, smtpOptions } from "./zoho-email.js";
import { env } from "../config/env.js";
const email = {
  from: "USVC <noreply@example.test>",
  to: "customer@example.test",
  replyTo: "support@example.test",
  subject: "Synthetic",
  html: "<p>Saved application</p>",
  text: "Saved application",
};
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
test("SMTP sends the existing content with a stable reference and no HTTP send", async (t) => {
  let closed = 0;
  t.mock.method(nodemailer, "createTransport", (options: unknown) => {
    assert.deepEqual(options, smtpOptions());
    return {
      sendMail: async (message: Record<string, unknown>) => {
        assert.equal(message.html, email.html);
        assert.equal(message.text, email.text);
        assert.deepEqual(message.headers, { "X-TM-CLIENT-REF": "opaque-reference" });
        assert.equal(message.messageId, "<opaque-reference@example.test>");
        assert.deepEqual(message.to, { address: email.to });
        return {
          accepted: [email.to],
          rejected: [],
          response: "250 Message accepted",
          messageId: "smtp-id",
        };
      },
      close: () => {
        closed++;
      },
    } as unknown as ReturnType<typeof nodemailer.createTransport>;
  });
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw Error("HTTP sending forbidden");
  });
  assert.deepEqual(await new ZohoEmailClient().send(email, "opaque-reference"), {
    kind: "accepted",
    messageId: "smtp-id",
  });
  assert.equal(closed, 1);
  assert.equal(fetch.mock.callCount(), 0);
});
test("SMTP requires encrypted authenticated connections on both supported ports", () => {
  const old = env.SMTP_PORT;
  try {
    for (const port of [465, 587] as const) {
      env.SMTP_PORT = port;
      const options = smtpOptions();
      assert.equal(options.secure, port === 465);
      assert.equal(options.requireTLS, true);
      assert.equal(options.tls.rejectUnauthorized, true);
      assert.equal(options.debug, false);
      assert.equal(options.logger, false);
      assert.equal(options.disableFileAccess, true);
      assert.equal(options.disableUrlAccess, true);
      assert.ok(options.socketTimeout < 120000);
    }
  } finally {
    env.SMTP_PORT = old;
  }
});
test("SMTP retries only explicit temporary rejections; lost DATA replies remain uncertain", async (t) => {
  for (const code of [421, 450, 451, 550, 535, undefined])
    await t.test(String(code), async (st) => {
      st.mock.method(
        nodemailer,
        "createTransport",
        () =>
          ({
            sendMail: async () => {
              throw Object.assign(Error("private body and credentials"), {
                responseCode: code,
                command: "DATA",
              });
            },
            close: () => {},
          }) as unknown as ReturnType<typeof nodemailer.createTransport>,
      );
      const result = await new ZohoEmailClient().send(email, "opaque");
      assert.equal(result.kind, code ? "rejected" : "uncertain");
      if (result.kind === "rejected") assert.equal(result.retryable, code! < 500);
      assert.doesNotMatch(JSON.stringify(result), /private|credentials/);
    });
});
test("invalid sender or reference never opens an SMTP connection", async (t) => {
  const mock = t.mock.method(nodemailer, "createTransport", () => {
    throw Error("must not call");
  });
  for (const [from, ref] of [
    ["bad\r\nBcc: injected@example.test", "opaque"],
    [email.from, "bad\r\nheader"],
  ])
    assert.equal((await new ZohoEmailClient().send({ ...email, from }, ref)).kind, "rejected");
  assert.equal(mock.mock.callCount(), 0);
});
test("Zoho log lookup uses scoped OAuth, refreshes once after 401 and checks reference ownership", async (t) => {
  const old = { ...env };
  Object.assign(env, {
    ZOHO_EMAIL_AGENT_KEY: "agent",
    ZOHO_OAUTH_CLIENT_ID: "client",
    ZOHO_OAUTH_CLIENT_SECRET: "secret",
    ZOHO_OAUTH_REFRESH_TOKEN: "refresh",
  });
  try {
    let refreshes = 0,
      queries = 0;
    t.mock.method(globalThis, "fetch", async (input: unknown, options: RequestInit) => {
      const url = String(input);
      if (url === "https://accounts.zoho.in/oauth/v2/token") {
        refreshes++;
        assert.equal(options.method, "POST");
        assert.match(String(options.body), /grant_type=refresh_token/);
        return response({ access_token: "access-" + refreshes, expires_in: 3600 });
      }
      const parsed = new URL(url);
      assert.equal(parsed.hostname, "cpaas.zoho.in");
      assert.equal(parsed.searchParams.get("mailagent_key"), "agent");
      assert.equal(parsed.searchParams.get("client_reference"), "opaque");
      assert.match((options.headers as Record<string, string>).Authorization, /^Zoho-oauthtoken /);
      queries++;
      if (queries === 1) return response({}, 401);
      return response({
        status: "success",
        data: [
          {
            mailagent_key: "agent",
            client_reference: "opaque",
            request_id: "existing",
            status: "hard bounced",
          },
        ],
      });
    });
    const client = new ZohoEmailClient();
    assert.deepEqual(await client.find("opaque"), { messageId: "existing" });
    await client.find("opaque");
    assert.equal(refreshes, 2);
  } finally {
    Object.assign(env, old);
  }
});
test("Zoho reconciliation treats empty, mismatched and failed log lookups conservatively", async (t) => {
  const old = { ...env };
  Object.assign(env, { ZOHO_EMAIL_AGENT_KEY: "agent" });
  try {
    for (const kind of ["empty", "wrong-agent", "wrong-reference", "malformed", "oauth-failed"])
      await t.test(kind, async (st) => {
        st.mock.method(globalThis, "fetch", async (input: unknown) => {
          if (String(input).includes("accounts.zoho.in"))
            return kind === "oauth-failed"
              ? response({ error: "private-secret" }, 400)
              : response({ access_token: "access", expires_in: 3600 });
          if (kind === "malformed") return response({ sensitive: "must-not-log" });
          return response({
            status: "success",
            data:
              kind === "empty"
                ? []
                : [
                    {
                      mailagent_key: kind === "wrong-agent" ? "other" : "agent",
                      client_reference: kind === "wrong-reference" ? "other" : "opaque",
                      request_id: "id",
                    },
                  ],
          });
        });
        if (kind === "empty") assert.equal(await new ZohoEmailClient().find("opaque"), null);
        else
          await assert.rejects(() => new ZohoEmailClient().find("opaque"), /^Error: ZOHO_[A-Z_]+$/);
      });
  } finally {
    Object.assign(env, old);
  }
});
test("sender parsing accepts existing display-name configuration and rejects header injection", () => {
  assert.deepEqual(parseSender("US Vital Certificates <noreply@example.test>"), {
    name: "US Vital Certificates",
    address: "noreply@example.test",
  });
  assert.deepEqual(parseSender("noreply@example.test"), { address: "noreply@example.test" });
  assert.throws(() => parseSender("Example\r\nBcc: private@example.test"));
});
