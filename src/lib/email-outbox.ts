import { renderRecoveryEmail } from "./recovery-email.js";
import { recoveryUrl } from "./recovery-url.js";
import mongoose from "mongoose";
import {
  preparePaymentRecovery,
  recoveryEmailOutcome,
  expireOrphanedPaymentRecoveries,
} from "./payment-recovery.js";
import { RecoveryGrant, RecoveryChallenge } from "../models/recovery.js";
import { decryptSensitive } from "./crypto.js";
import { createHash, randomUUID } from "node:crypto";
import type { ClientSession } from "mongoose";
import { zohoEmail, hasZohoLogCredentials } from "./zoho-email.js";
import { EmailDispatch } from "../models/email-dispatch.js";
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
  return /^ZOHO_[A-Z0-9_]+$/.test(message) ? message : "Email delivery temporarily unavailable";
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
  ).select("+setupToken +recoverySecret +recoveryContent");
}

export async function processNextEmail(): Promise<boolean> {
  if (!env.EMAIL_ENABLED) return false;
  // Held legacy invitation jobs must not retain expired setup tokens indefinitely.
  await EmailOutbox.updateMany(
    {
      template: "STAFF_INVITATION",
      createdAt: { $lte: new Date(Date.now() - 48 * 60 * 60_000) },
      setupToken: { $exists: true },
    },
    { $unset: { setupToken: 1 } },
  );
  if (await reconcileNextEmail()) return true;
  await expireOrphanedPaymentRecoveries();
  await EmailOutbox.updateMany(
    {
      template: { $ne: "PAYMENT_RECOVERY" },
      recoveryExpiresAt: { $lte: new Date() },
      recoverySecret: { $exists: true },
    },
    {
      $unset: { recoverySecret: 1, recoveryContent: 1 },
      $set: { status: "FAILED", lastError: "Recovery email expired" },
    },
  );
  const message = await leaseNextMessage(new Date());
  if (!message) return false;

  let dispatch = await EmailDispatch.findById(message._id).lean();
  if (!dispatch) {
    try {
      dispatch = (
        await EmailDispatch.create({
          _id: message._id,
          provider: message.attempts > 1 ? "LEGACY" : "ZOHO",
          reference: createHash("sha256")
            .update(`${env.MONGODB_DB_NAME}:${message._id}`)
            .digest("hex"),
          state: message.attempts > 1 ? "REVIEW" : "READY",
          ...(message.attempts > 1 ? { reason: "LEGACY_DISPATCH_REQUIRES_REVIEW" } : {}),
          template: message.template,
          orderId: message.orderId,
          contactMessageId: message.contactMessageId,
          staffUserId: message.staffUserId,
        })
      ).toObject();
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      dispatch = await EmailDispatch.findById(message._id).lean();
    }
  }
  const lease = { _id: message._id, status: "SENDING", attempts: message.attempts };
  if (!dispatch || dispatch.state !== "READY") {
    if (dispatch?.state === "ACCEPTED") await finishAcceptedEmail(dispatch);
    else
      await EmailOutbox.updateOne(lease, {
        $set: { status: "HELD", lastError: "Email dispatch requires reconciliation" },
        $unset: { leaseExpiresAt: 1 },
      });
    return true;
  }
  let dispatched = false;
  try {
    // Stable year keeps provider-idempotent payloads identical across New Year retries.
    const emailYear = message.createdAt.getUTCFullYear();
    let email: { subject: string; html: string; text: string };
    let replyTo: string;
    if (message.template === "PAYMENT_RECOVERY") {
      const prepared = await preparePaymentRecovery(message);
      if (!prepared) {
        if ((await EmailOutbox.findById(message._id).select("status").lean())?.status === "SKIPPED")
          await EmailDispatch.updateOne(
            { _id: message._id, state: "READY" },
            { $set: { state: "SKIPPED", reason: "PAYMENT_RECOVERY_INELIGIBLE" } },
          );
        return true;
      }
      email = prepared;
      replyTo = env.EMAIL_REPLY_TO!;
    } else if (message.template === "RECOVERY_LINK" || message.template === "RECOVERY_CODE") {
      const grant = await RecoveryGrant.exists({
        _id: message.recoveryGrantId,
        revokedAt: { $exists: false },
        expiresAt: { $gt: new Date() },
      });
      const challenge =
        message.template !== "RECOVERY_CODE" ||
        (await RecoveryChallenge.exists({
          _id: message.recoveryChallengeId,
          usedAt: { $exists: false },
          expiresAt: { $gt: new Date() },
        }));
      if (
        !grant ||
        !challenge ||
        !message.recoveryExpiresAt ||
        message.recoveryExpiresAt <= new Date() ||
        !message.recoverySecret
      ) {
        await EmailOutbox.deleteOne({ _id: message._id });
        await EmailDispatch.updateOne(
          { _id: message._id, state: "READY" },
          { $set: { state: "SKIPPED", reason: "EMAIL_GRANT_NO_LONGER_VALID" } },
        );
        return true;
      }
      const secret = decryptSensitive(message.recoverySecret);
      const recoveryGrant = await RecoveryGrant.findById(message.recoveryGrantId)
        .select("orderId")
        .lean();
      const recoveryOrder = recoveryGrant?.orderId
        ? await Order.findById(recoveryGrant.orderId).select("stateSlug certificate").lean()
        : null;
      email = renderRecoveryEmail(
        message.template,
        message.template === "RECOVERY_LINK"
          ? recoveryUrl(env.FRONTEND_URL, secret, recoveryOrder)
          : secret,
        env.FRONTEND_URL,
        emailYear,
      );
      replyTo = env.EMAIL_REPLY_TO!;
    } else if (message.template === "PAYMENT_CONFIRMATION") {
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
        emailYear,
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
        emailYear,
      );
      replyTo = env.EMAIL_REPLY_TO!;
    } else if (message.template === "STAFF_INVITATION") {
      // Top-level branch: invitation jobs carry no contactMessageId, so they
      // must never fall through to the contact lookup below (it throws and
      // the invite dies in retries without ever reaching the provider).
      const staff = await StaffUser.findById(message.staffUserId).select("+inviteTokenHash").lean();
      const jobToken = (message as { setupToken?: string }).setupToken;
      const resolved = resolveStaffInvitation(
        staff as { inviteTokenHash?: string } | null,
        jobToken,
        env.STAFF_PORTAL_URL!,
      );
      if ("drop" in resolved) {
        await EmailOutbox.deleteOne({ _id: message._id });
        await EmailDispatch.updateOne(
          { _id: message._id, state: "READY" },
          { $set: { state: "SKIPPED", reason: "EMAIL_GRANT_NO_LONGER_VALID" } },
        );
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
        email = renderContactCustomerReceipt(contact, env.FRONTEND_URL, emailYear);
        replyTo = env.EMAIL_REPLY_TO!;
      }
    }
    const recipient = env.EMAIL_RECIPIENT_OVERRIDE ?? message.recipient;
    const now = new Date();
    const expiry =
      message.recoveryExpiresAt ??
      (message.template === "STAFF_INVITATION"
        ? new Date(message.createdAt.getTime() + 48 * 60 * 60_000)
        : undefined);
    if (expiry && expiry <= now) {
      await EmailDispatch.updateOne(
        { _id: message._id, state: "READY" },
        { $set: { state: "SKIPPED", reason: "EMAIL_EXPIRED" } },
      );
      await EmailOutbox.updateOne(lease, {
        $set: { status: "SKIPPED" },
        $unset: { leaseExpiresAt: 1, setupToken: 1, recoverySecret: 1, recoveryContent: 1 },
      });
      return true;
    }
    const dispatchToken = randomUUID();
    const deadlineAt = new Date(
      Math.min(now.getTime() + 24 * 60 * 60_000, expiry?.getTime() ?? Infinity),
    );
    await mongoose.connection.transaction(async (session) => {
      const owned = await EmailOutbox.updateOne(
        { ...lease, leaseExpiresAt: { $gt: new Date() } },
        { $set: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) } },
        { session },
      );
      if (!owned.matchedCount) throw new Error("Email lease lost");
      const reserved = await EmailDispatch.updateOne(
        { _id: message._id, state: "READY" },
        {
          $set: {
            state: "DISPATCHING",
            dispatchToken,
            startedAt: now,
            deadlineAt,
            nextReconcileAt: new Date(now.getTime() + LEASE_MS),
          },
        },
        { session },
      );
      if (!reserved.modifiedCount) throw new Error("Email dispatch already reserved");
    });
    dispatched = true;
    const result = await zohoEmail.send(
      {
        from: env.EMAIL_FROM!,
        to: recipient,
        replyTo,
        subject: email.subject,
        html: email.html,
        text: email.text,
      },
      dispatch.reference,
    );
    if (result.kind === "accepted") {
      await EmailDispatch.updateOne(
        { _id: message._id, dispatchToken, state: { $in: ["DISPATCHING", "UNCERTAIN", "REVIEW"] } },
        {
          $set: {
            state: "ACCEPTED",
            providerMessageId: result.messageId,
            acceptedAt: new Date(),
            nextReconcileAt: new Date(),
          },
          $unset: { reconcileLeaseUntil: 1 },
        },
      );
      await finishAcceptedEmail(await EmailDispatch.findById(message._id).lean());
    } else if (result.kind === "uncertain") {
      await EmailDispatch.updateOne(
        { _id: message._id, dispatchToken, state: "DISPATCHING" },
        {
          $set: {
            state: "UNCERTAIN",
            reason: result.code,
            nextReconcileAt: new Date(Date.now() + 60_000),
          },
        },
      );
      await EmailOutbox.updateOne(lease, {
        $set: { status: "HELD", lastError: "Email delivery result is uncertain" },
        $unset: { leaseExpiresAt: 1 },
      });
    } else {
      const retry = result.retryable && message.attempts < MAX_ATTEMPTS;
      await mongoose.connection.transaction(async (session) => {
        const recorded = await EmailDispatch.updateOne(
          { _id: message._id, dispatchToken, state: "DISPATCHING" },
          {
            $set: { state: retry ? "READY" : "FAILED", reason: result.code },
            $unset: { nextReconcileAt: 1, reconcileLeaseUntil: 1 },
          },
          { session },
        );
        if (!recorded.modifiedCount) return;
        // A newer worker may have reclaimed the lease only to hold this dispatch.
        // The receipt's dispatchToken is the authority for this definitive result.
        await EmailOutbox.updateOne(
          { _id: message._id, status: { $in: ["SENDING", "HELD", "PENDING"] } },
          {
            $set: {
              status: retry ? "PENDING" : "FAILED",
              nextAttemptAt: new Date(
                Date.now() + Math.max(retryDelayMs(message.attempts), result.retryAfterMs ?? 0),
              ),
              lastError: message.template.includes("RECOVERY")
                ? "Recovery email delivery failed"
                : result.code,
            },
            $unset: {
              leaseExpiresAt: 1,
              ...(!retry ? { setupToken: 1, recoverySecret: 1, recoveryContent: 1 } : {}),
            },
          },
          { session },
        );
        if (!retry)
          await recordEmailAudit(
            message,
            "failed",
            new Date(),
            { attempts: message.attempts, code: result.code },
            session,
          );
      });
    }
  } catch (error) {
    // Once dispatch was reserved, even a local DB failure must not enter the send-retry path.
    if (dispatched) return true;
    const failedPermanently = message.attempts >= MAX_ATTEMPTS;
    const now = new Date();
    await mongoose.connection.transaction(async (session) => {
      const updated = await EmailOutbox.updateOne(
        { _id: message._id, status: "SENDING", attempts: message.attempts },
        {
          $set: {
            status: failedPermanently ? "FAILED" : "PENDING",
            nextAttemptAt: new Date(now.getTime() + retryDelayMs(message.attempts)),
            lastError:
              message.template.startsWith("RECOVERY_") || message.template === "PAYMENT_RECOVERY"
                ? "Recovery email delivery failed"
                : sanitizeEmailError(error),
          },
          $unset: {
            leaseExpiresAt: 1,
            ...(failedPermanently ? { setupToken: 1, recoverySecret: 1, recoveryContent: 1 } : {}),
          },
        },
        { session },
      );
      if (updated.modifiedCount && failedPermanently)
        await EmailDispatch.updateOne(
          { _id: message._id, state: "READY" },
          { $set: { state: "FAILED", reason: "EMAIL_PREPARATION_FAILED" } },
          { session },
        );
      if (updated.modifiedCount && failedPermanently)
        await recordEmailAudit(message, "failed", now, { attempts: message.attempts }, session);
    });
  }
  return true;
}

export async function finishAcceptedEmail(dispatch: any): Promise<void> {
  if (!dispatch || dispatch.state !== "ACCEPTED") return;
  await mongoose.connection.transaction(async (session) => {
    const claimed = await EmailDispatch.updateOne(
      { _id: dispatch._id, state: "ACCEPTED", finalizedAt: { $exists: false } },
      { $set: { finalizedAt: new Date() }, $unset: { nextReconcileAt: 1, reconcileLeaseUntil: 1 } },
      { session },
    );
    await EmailOutbox.updateOne(
      { _id: dispatch._id },
      {
        $set: {
          status: "SENT",
          providerMessageId: dispatch.providerMessageId,
          sentAt: dispatch.acceptedAt,
        },
        $unset: {
          leaseExpiresAt: 1,
          lastError: 1,
          setupToken: 1,
          recoverySecret: 1,
          recoveryContent: 1,
        },
      },
      { session },
    );
    if (!claimed.modifiedCount) return;
    await recordEmailAudit(
      dispatch,
      "sent",
      dispatch.acceptedAt ?? new Date(),
      { provider: "ZOHO", providerMessageId: dispatch.providerMessageId },
      session,
    );
  });
}

export async function reconcileEmailDispatch(id: string, manual = false): Promise<void> {
  const dispatch = await EmailDispatch.findById(id).lean();
  if (!dispatch) return;
  if (dispatch.state === "ACCEPTED") {
    await finishAcceptedEmail(dispatch);
    return;
  }
  if (
    dispatch.provider !== "ZOHO" ||
    !["DISPATCHING", "UNCERTAIN", ...(manual ? ["REVIEW"] : [])].includes(dispatch.state)
  )
    return;
  const now = new Date();
  if (!manual && dispatch.deadlineAt && dispatch.deadlineAt <= now) {
    await EmailDispatch.updateOne(
      { _id: id, state: { $in: ["DISPATCHING", "UNCERTAIN"] } },
      {
        $set: { state: "REVIEW", reason: "RECONCILIATION_DEADLINE" },
        $unset: { nextReconcileAt: 1, reconcileLeaseUntil: 1 },
      },
    );
    await EmailOutbox.updateOne(
      { _id: id, status: { $ne: "SENT" } },
      {
        $set: { status: "HELD", lastError: "Email delivery requires operator review" },
        $unset: { leaseExpiresAt: 1, recoverySecret: 1, recoveryContent: 1, setupToken: 1 },
      },
    );
    return;
  }
  let found: { messageId: string } | null = null;
  try {
    if (hasZohoLogCredentials()) found = await zohoEmail.find(dispatch.reference);
  } catch {
    /* No provider content or credentials are logged. */
  }
  if (found) {
    await EmailDispatch.updateOne(
      { _id: id, state: { $in: ["DISPATCHING", "UNCERTAIN", "REVIEW"] } },
      {
        $set: {
          state: "ACCEPTED",
          providerMessageId: found.messageId,
          acceptedAt: now,
          nextReconcileAt: now,
        },
      },
    );
    await finishAcceptedEmail(await EmailDispatch.findById(id).lean());
  } else if (!manual) {
    const count = (dispatch.reconcileAttempts ?? 0) + 1;
    const next = new Date(
      Math.min(
        now.getTime() + Math.min(60 * 60_000, 60_000 * 2 ** Math.min(count, 6)),
        dispatch.deadlineAt?.getTime() ?? Infinity,
      ),
    );
    await EmailDispatch.updateOne(
      { _id: id, state: { $in: ["DISPATCHING", "UNCERTAIN"] } },
      {
        $set: {
          state: "UNCERTAIN",
          reason: hasZohoLogCredentials()
            ? "AWAITING_PROVIDER_EVIDENCE"
            : "AWAITING_SIGNED_WEBHOOK",
          nextReconcileAt: next,
        },
        $inc: { reconcileAttempts: 1 },
        $unset: { reconcileLeaseUntil: 1 },
      },
    );
  }
}

async function reconcileNextEmail(): Promise<boolean> {
  const now = new Date();
  const dispatch = await EmailDispatch.findOneAndUpdate(
    {
      state: { $in: ["DISPATCHING", "UNCERTAIN", "ACCEPTED"] },
      finalizedAt: { $exists: false },
      nextReconcileAt: { $lte: now },
      $or: [{ reconcileLeaseUntil: { $exists: false } }, { reconcileLeaseUntil: { $lte: now } }],
    },
    { $set: { reconcileLeaseUntil: new Date(now.getTime() + 60_000) } },
    { returnDocument: "after", sort: { nextReconcileAt: 1 } },
  ).lean();
  if (!dispatch) return false;
  await reconcileEmailDispatch(dispatch._id);
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
  session?: ClientSession,
): Promise<void> {
  if (message.template === "PAYMENT_RECOVERY") {
    await recoveryEmailOutcome(message.orderId, outcome === "sent" ? "SENT" : "FAILED", session);
    return;
  }
  if (message.template.startsWith("RECOVERY_")) return;
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
      { session },
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
      { session },
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
    { session },
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
