import mongoose from "mongoose";

const { Schema } = mongoose;
const model = mongoose.model.bind(mongoose);
const models = mongoose.models as Record<string, any>;

const EmailOutboxSchema = new Schema(
  {
    _id: { type: String, required: true },
    orderId: { type: Schema.Types.ObjectId, index: true },
    contactMessageId: { type: Schema.Types.ObjectId, index: true },
    staffUserId: { type: Schema.Types.ObjectId, index: true },
    /**
     * Single-use staff setup token (plaintext). Present only on
     * STAFF_INVITATION jobs; redacted ($unset) the moment the email is SENT.
     * Tokens expire 48h after issue regardless.
     */
    setupToken: { type: String, select: false },
    recipient: { type: String, required: true },
    template: {
      type: String,
      enum: [
        "PAYMENT_CONFIRMATION",
        "CONTACT_SUPPORT_NOTIFICATION",
        "CONTACT_CUSTOMER_RECEIPT",
        "STAFF_INVITATION",
        "SUBMISSION_NOTIFICATION",
      ],
      required: true,
    },
    status: {
      type: String,
      enum: ["PENDING", "SENDING", "SENT", "FAILED"],
      default: "PENDING",
      index: true,
    },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now, index: true },
    leaseExpiresAt: { type: Date },
    providerMessageId: { type: String },
    sentAt: { type: Date },
    lastError: { type: String },
  },
  { timestamps: true },
);

EmailOutboxSchema.index({ status: 1, nextAttemptAt: 1 });

export const EmailOutbox =
  models.EmailOutbox ?? model("EmailOutbox", EmailOutboxSchema, "email_outbox");
