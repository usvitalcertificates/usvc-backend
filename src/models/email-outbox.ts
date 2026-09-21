import mongoose from "mongoose";

const { Schema } = mongoose;
const model = mongoose.model.bind(mongoose);
const models = mongoose.models as Record<string, any>;

const EmailOutboxSchema = new Schema(
  {
    _id: { type: String, required: true },
    orderId: { type: Schema.Types.ObjectId, required: true, index: true },
    recipient: { type: String, required: true },
    template: { type: String, enum: ["PAYMENT_CONFIRMATION"], required: true },
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
