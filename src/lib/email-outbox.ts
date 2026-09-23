import { Resend } from "resend";
import { env } from "../config/env.js";
import { ContactMessage } from "../models/contact-message.js";
import { EmailOutbox } from "../models/email-outbox.js";
import { Order } from "../models/order.js";
import { StaffUser } from "../models/staff.js";
import { resolveStaffInvitation } from "./staff-email.js";
import { renderSubmissionNotificationEmail } from "./submission-notification-email.js";
import { renderContactCustomerReceipt, renderContactSupportEmail } from "./contact-email.js";
import { renderPaymentConfirmationEmail } from "./payment-confirmation-email.js";

const MAX_ATTEMPTS = 10;
const POLL_INTERVAL_MS = 5_000;
const LEASE_MS = 2 * 60_000;
let timer: NodeJS.Timeout | undefined;
let draining = false;

export function retryDelayMs(attempts: number): number {
  return Math.min(60 * 60_000, 5_000 * 2 ** Math.max(0, attempts - 1));
}

export function sanitizeEmailError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Email provider request failed";
  return message.replace(/[\r\n]+/g, " ").slice(0, 500);
}

async function leaseNextMessage(now: Date) {
  // setupToken is select:false in the schema (never returned by default
  // projections) but the STAFF_INVITATION stale-check needs it — without this
  // explicit select every invitation job looks stale and gets dropped.
  return EmailOutbox.findOneAndUpdate(
    {
      $or: [
        { status: "PENDING", nextAttemptAt: { $lte: now } },
        { status: "SENDING", leaseExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: { status: "SENDING", leaseExpiresAt: new Date(now.getTime() + LEASE_MS) },
      $inc: { attempts: 1 },
    },
    { returnDocument: "after", sort: { nextAttemptAt: 1 } },
  ).select("+setupToken");
}

export async function processNextEmail(): Promise<boolean> {
  if (!env.EMAIL_ENABLED) return false;
  const message = await leaseNextMessage(new Date());
  if (!message) return false;

  try {
    let email: { subject: string; html: string; text: string };
    let replyTo: string;
    if (message.template === "PAYMENT_CONFIRMATION") {
      const order = await Order.findById(message.orderId).lean();
      if (!order) throw new Error("Order for confirmation email no longer exists");
      email = renderPaymentConfirmationEmail(
        {
          publicNumber: order.publicNumber,
          stateName: order.stateName,
          certificate: order.certificate,
          copies: order.copies,
          pricing: order.pricing,
        },
        env.FRONTEND_URL,
      );
      replyTo = env.EMAIL_REPLY_TO!;
    } else if (message.template === "SUBMISSION_NOTIFICATION") {
      const order = await Order.findById(message.orderId).lean();
      if (!order) throw new Error("Order for submission email no longer exists");
      email = renderSubmissionNotificationEmail(
        {
          publicNumber: order.publicNumber,
          stateName: order.stateName,
          certificate: order.certificate,
          copies: order.copies,
          rush: order.rush,
          requestorFirstName: order.applicant?.firstName || "",
          submittedAt: order.customerTimeline?.submittedToAgencyAt ?? order.updatedAt,
        },
        env.FRONTEND_URL,
      );
      replyTo = env.EMAIL_REPLY_TO!;
    } else if (message.template === "STAFF_INVITATION") {
      // Top-level branch: invitation jobs carry no contactMessageId, so they
      // must never fall through to the contact lookup below (it throws and
      // the invite dies in retries without ever reaching Resend).
      const staff = await StaffUser.findById(message.staffUserId).select("+inviteTokenHash").lean();
      const jobToken = (message as { setupToken?: string }).setupToken;
      const resolved = resolveStaffInvitation(
        staff as { fullName?: string; inviteTokenHash?: string } | null,
        jobToken,
        env.STAFF_PORTAL_URL!,
      );
      if ("drop" in resolved) {
        await EmailOutbox.deleteOne({ _id: message._id });
        return true;
      }
      email = resolved.email;
      replyTo = env.EMAIL_REPLY_TO!;
    } else {
      const contact = await ContactMessage.findById(message.contactMessageId).lean();
      if (!contact) throw new Error("Contact message for email no longer exists");
      if (message.template === "CONTACT_SUPPORT_NOTIFICATION") {
        email = renderContactSupportEmail(contact);
        replyTo = contact.email;
      } else {
        email = renderContactCustomerReceipt(contact);
        replyTo = env.EMAIL_REPLY_TO!;
      }
    }
    const recipient = env.EMAIL_RECIPIENT_OVERRIDE ?? message.recipient;
    const resend = new Resend(env.RESEND_API_KEY!);
    const result = await resend.emails.send(
      {
        from: env.EMAIL_FROM!,
        to: recipient,
        replyTo,
        subject: email.subject,
        html: email.html,
        text: email.text,
      },
      { idempotencyKey: message._id },
    );
    if (result.error) throw new Error(result.error.message);

    const sentAt = new Date();
    await EmailOutbox.updateOne(
      { _id: message._id, status: "SENDING" },
      {
        $set: {
          status: "SENT",
          providerMessageId: result.data?.id,
          sentAt,
        },
        // Single-use setup tokens must not linger once delivered.
        $unset: { leaseExpiresAt: 1, lastError: 1, setupToken: 1 },
      },
    );
    await recordEmailAudit(message, "sent", sentAt, { providerMessageId: result.data?.id });
  } catch (error) {
    const failedPermanently = message.attempts >= MAX_ATTEMPTS;
    const now = new Date();
    await EmailOutbox.updateOne(
      { _id: message._id, status: "SENDING" },
      {
        $set: {
          status: failedPermanently ? "FAILED" : "PENDING",
          nextAttemptAt: new Date(now.getTime() + retryDelayMs(message.attempts)),
          lastError: sanitizeEmailError(error),
        },
        $unset: { leaseExpiresAt: 1 },
      },
    );
    if (failedPermanently)
      await recordEmailAudit(message, "failed", now, { attempts: message.attempts });
  }
  return true;
}

async function recordEmailAudit(
  message: {
    orderId?: unknown;
    contactMessageId?: unknown;
    staffUserId?: unknown;
    template: string;
  },
  outcome: "sent" | "failed",
  createdAt: Date,
  metadata: Record<string, unknown>,
): Promise<void> {
  if (message.orderId) {
    const submitted = message.template === "SUBMISSION_NOTIFICATION";
    await Order.updateOne(
      { _id: message.orderId },
      {
        $push: {
          auditEvents: {
            action:
              outcome === "sent"
                ? submitted
                  ? "submission_email_sent"
                  : "confirmation_email_sent"
                : submitted
                  ? "submission_email_failed"
                  : "confirmation_email_failed",
            metadata,
            createdAt,
          },
        },
      },
    );
    return;
  }
  if (message.staffUserId) {
    await StaffUser.updateOne(
      { _id: message.staffUserId },
      {
        $push: {
          auditEvents: {
            action: outcome === "sent" ? "invitation_email_sent" : "invitation_email_failed",
            metadata,
            createdAt,
          },
        },
      },
    );
    return;
  }
  await ContactMessage.updateOne(
    { _id: message.contactMessageId },
    {
      $push: {
        emailEvents: {
          action: outcome === "sent" ? "contact_email_sent" : "contact_email_failed",
          metadata: { ...metadata, template: message.template },
          createdAt,
        },
      },
    },
  );
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (await processNextEmail()) {
      // Drain all currently due messages before returning to the timer.
    }
  } catch (error) {
    console.error("Email outbox worker failed", sanitizeEmailError(error));
  } finally {
    draining = false;
  }
}

export function startEmailOutboxWorker(): void {
  if (!env.EMAIL_ENABLED || timer) return;
  void drain();
  timer = setInterval(() => void drain(), POLL_INTERVAL_MS);
  timer.unref();
}

export function stopEmailOutboxWorker(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
