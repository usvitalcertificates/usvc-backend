import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import argon2 from "argon2";
import { app } from "../app.js";
import { env } from "../config/env.js";
import { StaffUser } from "../models/staff.js";
import { EmailOutbox } from "../models/email-outbox.js";
import {
  encryptMfaSecret,
  newInviteToken,
  newTotpSecret,
  signStaffTokens,
  totpFor,
  verifyTotpCode,
} from "./staff-auth.js";
const uri = process.env.STAFF_AUTH_TEST_MONGODB_URI;
test(
  "staff recovery with real HTTP and isolated local MongoDB",
  { skip: !uri, timeout: 60000 },
  async (t) => {
    assert.match(uri!, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//);
    await mongoose.connect(uri!, {
      dbName: `usvc_staff_recovery_test_${randomUUID().replaceAll("-", "")}`,
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    let seq = 0;
    const call = async (path: string, body?: unknown, access?: string) => {
      const r = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": `192.0.2.${++seq}`,
          ...(access ? { authorization: `Bearer ${access}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: r.status, data: await r.json() };
    };
    const enabled = env.EMAIL_ENABLED;
    env.EMAIL_ENABLED = false;
    try {
      const passwordHash = await argon2.hash("OriginalPassword123");
      const admin = await StaffUser.create({
        email: "admin@example.test",
        passwordHash,
        role: "ADMIN",
      });
      const access = signStaffTokens(admin).accessToken;
      const secret = newTotpSecret().base32;
      const first = await StaffUser.create({
        email: "first@example.test",
        passwordHash,
        role: "CS",
        mfaEnabled: true,
        mfaSecret: encryptMfaSecret(secret),
      });
      const second = await StaffUser.create({
        email: "second@example.test",
        passwordHash,
        role: "CS",
        mfaEnabled: true,
        mfaSecret: encryptMfaSecret(newTotpSecret().base32),
      });
      const reset = async (id: string) => {
        const r = await call(`/admin/staff/${id}/password-reset`, {}, access);
        assert.equal(r.status, 200);
        return r.data.setupToken;
      };
      await t.test(
        "enrolled reset uses existing authenticator; consumed and rotated links fail",
        async () => {
          const old = await reset(first.id);
          const token = await reset(first.id);
          assert.equal(
            (await call("/auth/setup", { token: old, password: "NewPassword123" })).status,
            400,
          );
          const setup = await call("/auth/setup", { token, password: "NewPassword123" });
          assert.equal(setup.status, 200);
          assert.equal(setup.data.enroll, false);
          assert.equal(
            (
              await call("/auth/mfa/verify", {
                mfaToken: setup.data.mfaToken,
                code: totpFor(secret, first.email).generate(),
              })
            ).status,
            200,
          );
          assert.equal(
            (await call("/auth/setup", { token, password: "OtherPassword123" })).status,
            400,
          );
          const user = await StaffUser.findById(first.id).lean();
          assert.equal(await argon2.verify(user.passwordHash, "NewPassword123"), true);
          assert.equal(user.mfaEnabled, true);
          const login = await call("/auth/login", {
            email: first.email,
            password: "NewPassword123",
          });
          assert.equal(login.status, 200);
          assert.equal(login.data.enroll, false);
        },
      );
      await t.test(
        "authenticator reset targets only selected account; roster tracks re-enrollment",
        async () => {
          assert.equal((await call(`/admin/staff/${second.id}/mfa-reset`, {}, access)).status, 200);
          let rows = (await call("/admin/staff", undefined, access)).data.staff;
          assert.equal(rows.find((r: any) => r.id === first.id).mfaEnabled, true);
          assert.equal(rows.find((r: any) => r.id === second.id).mfaEnabled, false);
          const token = await reset(second.id);
          const setup = await call("/auth/setup", { token, password: "NewPassword123" });
          assert.equal(setup.data.enroll, true);
          const pairing = await call("/auth/mfa/enroll", { mfaToken: setup.data.mfaToken });
          assert.equal(pairing.status, 200);
          let wrongCode = "000000";
          while (verifyTotpCode(pairing.data.secret, wrongCode)) {
            wrongCode = String(Number(wrongCode) + 1).padStart(6, "0");
          }
          assert.equal(
            (await call("/auth/mfa/confirm", { mfaToken: setup.data.mfaToken, code: wrongCode }))
              .status,
            401,
          );
          assert.equal((await StaffUser.findById(second.id).lean()).mfaEnabled, false);
          assert.equal(
            (await call("/auth/mfa/confirm", { mfaToken: setup.data.mfaToken, code: "x" })).status,
            400,
          );
          assert.equal(
            (
              await call("/auth/mfa/confirm", {
                mfaToken: setup.data.mfaToken,
                code: totpFor(pairing.data.secret, second.email).generate(),
              })
            ).status,
            200,
          );
          rows = (await call("/admin/staff", undefined, access)).data.staff;
          assert.equal(rows.find((r: any) => r.id === second.id).mfaEnabled, true);
          assert.ok(!JSON.stringify(rows).includes(pairing.data.secret));
        },
      );
      await t.test(
        "new invitation requires pairing and concurrent link use has one winner",
        async () => {
          const invite = await call(
            "/auth/invite",
            { fullName: "Synthetic", email: "invite@example.test", role: "CS" },
            access,
          );
          assert.equal(invite.status, 201);
          const r = await call("/auth/setup", {
            token: invite.data.setupToken,
            password: "InvitePassword123",
          });
          assert.equal(r.status, 200);
          assert.equal(r.data.enroll, true);
          const token = await reset(first.id);
          const results = await Promise.all(
            ["RacePassword123", "RacePassword456"].map((password) =>
              call("/auth/setup", { token, password }),
            ),
          );
          assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
        },
      );
      await t.test("expired and disabled links fail without changing password", async () => {
        for (const scenario of ["expired", "disabled"]) {
          const grant = newInviteToken();
          await StaffUser.updateOne(
            { _id: second._id },
            {
              $set: {
                inviteTokenHash: grant.tokenHash,
                inviteExpiresAt: new Date(Date.now() + (scenario === "expired" ? -1000 : 60000)),
                accountStatus: scenario === "disabled" ? "disabled" : "active",
              },
            },
          );
          assert.equal(
            (await call("/auth/setup", { token: grant.token, password: "NotSavedPassword123" }))
              .status,
            400,
          );
        }
        const user = await StaffUser.findById(second.id).lean();
        assert.equal(await argon2.verify(user.passwordHash, "NotSavedPassword123"), false);
      });
      await t.test(
        "email reset sends token only to outbox and anonymous resets are denied",
        async () => {
          env.EMAIL_ENABLED = true;
          const r = await call(`/admin/staff/${first.id}/password-reset`, {}, access);
          assert.equal(r.status, 200);
          assert.equal(r.data.emailed, true);
          assert.equal(r.data.setupToken, undefined);
          const job = await EmailOutbox.findOne({ staffUserId: first._id })
            .select("+setupToken")
            .lean();
          assert.ok(job.setupToken);
          assert.equal(job.recipient, first.email);
          assert.equal(
            (await call("/auth/setup", { token: job.setupToken, password: "EmailPassword123" }))
              .status,
            200,
          );
          assert.equal((await call(`/admin/staff/${first.id}/password-reset`, {})).status, 401);
        },
      );
    } finally {
      env.EMAIL_ENABLED = enabled;
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  },
);
