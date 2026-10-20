import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import nodemailer from "nodemailer";
import { ZohoEmailClient } from "./zoho-email.js";

// Loopback-only protocol test. Production TLS/auth defaults are tested separately.
test("real SMTP protocol acceptance, rejection and lost final DATA replies", async (t) => {
  for (const outcome of ["accepted", "temporary", "permanent", "lost"] as const) {
    await t.test(outcome, async (st) => {
      const sockets = new Set<Socket>();
      let mime = "";
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => {});
        socket.on("close", () => sockets.delete(socket));
        socket.write("220 loopback.test ESMTP\r\n");
        let buffer = "",
          data = false;
        socket.on("data", (chunk) => {
          buffer += chunk.toString();
          let at: number;
          while ((at = buffer.indexOf("\r\n")) >= 0) {
            const line = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            if (data) {
              if (line !== ".") {
                mime += line + "\r\n";
                continue;
              }
              data = false;
              if (outcome === "lost") {
                socket.destroy();
                return;
              }
              socket.write(
                outcome === "accepted"
                  ? "250 queued\r\n"
                  : outcome === "temporary"
                    ? "451 temporarily unavailable\r\n"
                    : "550 rejected\r\n",
              );
            } else if (/^EHLO/.test(line)) socket.write("250-loopback.test\r\n250 AUTH PLAIN\r\n");
            else if (/^AUTH/.test(line)) socket.write("235 authenticated\r\n");
            else if (/^(MAIL FROM|RCPT TO)/.test(line)) socket.write("250 OK\r\n");
            else if (line === "DATA") {
              data = true;
              socket.write("354 send message\r\n");
            } else if (line === "QUIT") socket.end("221 bye\r\n");
            else socket.write("250 OK\r\n");
          }
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;
      const original = nodemailer.createTransport.bind(nodemailer);
      st.mock.method(nodemailer, "createTransport", (options: Record<string, unknown>) =>
        original({
          ...options,
          host: "127.0.0.1",
          port,
          secure: false,
          requireTLS: false,
          auth: { user: "synthetic", pass: "synthetic" },
        }),
      );
      try {
        const result = await new ZohoEmailClient().send(
          {
            from: "USVC <noreply@example.test>",
            to: "synthetic@example.test",
            replyTo: "support@example.test",
            subject: "Synthetic protocol test",
            html: "<p>Synthetic body</p>",
            text: "Synthetic body",
          },
          "synthetic-reference",
        );
        assert.equal(
          result.kind,
          outcome === "accepted" ? "accepted" : outcome === "lost" ? "uncertain" : "rejected",
        );
        if (result.kind === "rejected") assert.equal(result.retryable, outcome === "temporary");
        assert.match(mime, /X-TM-CLIENT-REF: synthetic-reference/i);
        assert.match(mime, /Message-ID: <synthetic-reference@example.test>/i);
        assert.match(mime, /Reply-To: support@example.test/);
        assert.match(mime, /Synthetic body/);
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  }
});
