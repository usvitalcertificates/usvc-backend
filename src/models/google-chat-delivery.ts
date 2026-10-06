import mongoose from "mongoose";

const { Schema } = mongoose;
const model = mongoose.model.bind(mongoose);
const models = mongoose.models as Record<string, any>;

/** Paid-order Google Chat notifications. One row per order (`chat-notify:…`
 *  upsert id), leased + retried by the worker. Payload carries only the
 *  public order number, customer name, state/certificate labels, and
 *  city-level device/shipping locations — never PII, never raw IPs. */
const GoogleChatDeliverySchema = new Schema(
  {
    _id: { type: String, required: true },
    orderId: { type: Schema.Types.ObjectId, required: true, unique: true, index: true },
    publicNumber: { type: String, required: true },
    customerName: { type: String, required: true },
    stateName: { type: String, default: "" },
    certificate: { type: String, default: "" },
    deviceCity: { type: String, default: "" },
    deviceRegion: { type: String, default: "" },
    shipCity: { type: String, default: "" },
    shipState: { type: String, default: "" },
    status: {
      type: String,
      enum: ["PENDING", "SENDING", "SENT", "FAILED"],
      default: "PENDING",
      index: true,
    },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now, index: true },
    leaseExpiresAt: Date,
    sentAt: Date,
    lastError: String,
  },
  { timestamps: true },
);

GoogleChatDeliverySchema.index({ status: 1, nextAttemptAt: 1 });

export const GoogleChatDelivery =
  models.GoogleChatDelivery ??
  model("GoogleChatDelivery", GoogleChatDeliverySchema, "google_chat_deliveries");
