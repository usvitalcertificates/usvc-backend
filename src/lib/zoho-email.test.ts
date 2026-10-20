import test from "node:test";
import assert from "node:assert/strict";
import { ZohoEmailClient, parseSender } from "./zoho-email.js";
import { env } from "../config/env.js";
const email = {
  from: "USVC <noreply@example.test>",
  to: "customer@example.test",
  replyTo: "support@example.test",
  subject: "Synthetic",
  html: "<p>Saved application</p>",
  text: "Saved application",
};
const accepted = {
  data: [{ code: "EM_104", message: "OK" }],
  request_id: "zoho-request",
  message: "OK",
};
const failure = { data: { error_code: "TM_3004" }, message: "error" };
const response = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

test("Zoho adapter serializes the India API contract and disables tracking", async (t) => {
  const old = { ...env };
  Object.assign(env, { ZOHO_EMAIL_API_KEY: "synthetic-send-key" });
  t.mock.method(globalThis, "fetch", async (url: unknown, options: RequestInit) => {
    assert.equal(url, "https://cpaas.zoho.in/v1.1/email");
    assert.equal(
      (options.headers as Record<string, string>).Authorization,
      "Zoho-enczapikey synthetic-send-key",
    );
    const body = JSON.parse(String(options.body));
    assert.deepEqual(body, {
      from: { address: "noreply@example.test", name: "USVC" },
      to: [{ email_address: { address: email.to } }],
      reply_to: [{ address: email.replyTo }],
      subject: email.subject,
      htmlbody: email.html,
      textbody: email.text,
      client_reference: "opaque-reference",
      track_opens: false,
      track_clicks: false,
    });
    assert.equal(options.redirect, "error");
    return response(accepted);
  });
  try {
    assert.deepEqual(await new ZohoEmailClient().send(email, "opaque-reference"), {
      kind: "accepted",
      messageId: "zoho-request",
    });
  } finally {
    Object.assign(env, old);
  }
});
test("Zoho send results never retry ambiguous acceptance or expose provider contents", async (t) => {
  const cases = [
    { status: 429, body: failure, expected: "rejected", retry: true },
    { status: 400, body: failure, expected: "rejected", retry: false },
    { status: 401, body: failure, expected: "rejected", retry: false },
    { status: 503, body: failure, expected: "uncertain" },
    { status: 200, body: { request_id: "bad", data: [] }, expected: "uncertain" },
    { status: 429, body: { secret: "private-provider-data" }, expected: "uncertain" },
  ];
  for (const row of cases)
    await t.test(String(row.status) + " " + row.expected, async (st) => {
      st.mock.method(globalThis, "fetch", async () =>
        response(row.body, row.status, { "retry-after": "30" }),
      );
      const result = await new ZohoEmailClient().send(email, "opaque");
      assert.equal(result.kind, row.expected);
      if (result.kind === "rejected") {
        assert.equal(result.retryable, row.retry);
        assert.equal(result.retryAfterMs, 30000);
      }
      assert.doesNotMatch(JSON.stringify(result), /private-provider-data/);
    });
  await t.test("timeouts and invalid bodies remain uncertain", async (st) => {
    st.mock.method(globalThis, "fetch", async () => {
      throw Error("secret-recipient-and-token");
    });
    assert.deepEqual(await new ZohoEmailClient().send(email, "opaque"), {
      kind: "uncertain",
      code: "ZOHO_REQUEST_UNCERTAIN",
    });
  });
  await t.test("invalid sender is rejected before transmission", async (st) => {
    const mock = st.mock.method(globalThis, "fetch", async () => {
      throw Error("must not call");
    });
    assert.equal(
      (
        await new ZohoEmailClient().send(
          { ...email, from: "bad\r\nBcc: private@example.test" },
          "opaque",
        )
      ).kind,
      "rejected",
    );
    assert.equal(mock.mock.callCount(), 0);
  });
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

test("invalid message references and injected subjects never reach the API", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => {
    throw Error("must not send");
  });
  for (const [reference, subject] of [
    ["bad\r\nreference", email.subject],
    ["opaque", "bad\r\nsubject"],
  ]) {
    assert.deepEqual(await new ZohoEmailClient().send({ ...email, subject }, reference), {
      kind: "rejected",
      retryable: false,
      code: "ZOHO_MESSAGE_INVALID",
    });
  }
  assert.equal(mock.mock.callCount(), 0);
});
