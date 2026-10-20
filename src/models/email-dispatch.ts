import mongoose from "mongoose";
const { Schema } = mongoose;
/** Permanent non-content evidence. No recipients, bodies, credentials, or delivery secrets. */
const schema = new Schema(
  {
    _id: { type: String, required: true },
    provider: { type: String, enum: ["ZOHO", "LEGACY"], required: true },
    reference: { type: String, required: true, unique: true },
    state: {
      type: String,
      enum: ["READY", "DISPATCHING", "UNCERTAIN", "ACCEPTED", "FAILED", "SKIPPED", "REVIEW"],
      required: true,
    },
    dispatchToken: String,
    startedAt: Date,
    deadlineAt: Date,
    nextReconcileAt: Date,
    reconcileLeaseUntil: Date,
    reconcileAttempts: { type: Number, default: 0 },
    deliveryStatus: {
      type: String,
      enum: ["SOFT_BOUNCED", "DELIVERED", "HARD_BOUNCED", "COMPLAINED"],
    },
    deliveryRank: Number,
    deliveryUpdatedAt: Date,
    providerMessageId: String,
    acceptedAt: Date,
    finalizedAt: Date,
    reason: String,
    orderId: Schema.Types.ObjectId,
    contactMessageId: Schema.Types.ObjectId,
    staffUserId: Schema.Types.ObjectId,
    template: { type: String, required: true },
  },
  { timestamps: true },
);
schema.index({ state: 1, nextReconcileAt: 1 });
export const EmailDispatch =
  mongoose.models.EmailDispatch ?? mongoose.model("EmailDispatch", schema, "email_dispatches");
