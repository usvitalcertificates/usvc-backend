import assert from "node:assert/strict";
import test from "node:test";
import {
  contactSubmissionSchema,
  hasSensitiveContactContent,
  isContactSubmissionSuspicious,
} from "./contact-validation.js";
import { contactOutboxCreateOptions } from "../routes/contact.js";

test("accepts and normalizes a valid contact submission", () => {
  const submission = contactSubmissionSchema.parse({
    fullName: "  Jane Applicant ",
    email: "jane@example.com",
    orderNumber: " USVC-123 ",
    message: "Please provide an update on my order.",
    antiAbuse: { honeypot: "", formStartedAt: Date.now() - 3_000 },
  });
  assert.equal(submission.fullName, "Jane Applicant");
  assert.equal(submission.orderNumber, "USVC-123");
  assert.equal(isContactSubmissionSuspicious(submission.antiAbuse), false);
});

test("rejects malformed contact fields and detects likely sensitive content", () => {
  assert.throws(() =>
    contactSubmissionSchema.parse({
      fullName: "J",
      email: "not-an-email",
      message: "",
      antiAbuse: { honeypot: "", formStartedAt: 0 },
    }),
  );
  assert.equal(hasSensitiveContactContent("My SSN is 123-45-6789"), true);
  assert.equal(hasSensitiveContactContent("Card 4111 1111 1111 1111"), true);
  assert.equal(hasSensitiveContactContent("Please call me about my order."), false);
});

test("flags a bot field or implausibly fast contact submission", () => {
  assert.equal(
    isContactSubmissionSuspicious({ honeypot: "filled", formStartedAt: Date.now() - 10_000 }),
    true,
  );
  assert.equal(isContactSubmissionSuspicious({ honeypot: "", formStartedAt: Date.now() }), true);
});

test("uses ordered multi-document inserts inside the contact transaction", () => {
  const session = {} as never;
  const options = contactOutboxCreateOptions(session);
  assert.equal(options.session, session);
  assert.equal(options.ordered, true);
});
