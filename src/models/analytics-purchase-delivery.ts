import mongoose from "mongoose";

const { Schema } = mongoose;
const model = mongoose.model.bind(mongoose);
const models = mongoose.models as Record<string, any>;

const AnalyticsPurchaseDeliverySchema = new Schema(
  {
    _id: { type: String, required: true },
    orderId: { type: Schema.Types.ObjectId, required: true, unique: true, index: true },
    transactionId: { type: String, required: true, unique: true },
    amountCents: { type: Number, required: true },
    serviceCents: { type: Number, required: true },
    rushCents: { type: Number, required: true },
    currency: { type: String, required: true },
    certificate: { type: String, required: true },
    stateCode: { type: String, default: "" },
    copies: { type: Number, required: true },
    rush: { type: Boolean, required: true },
    clientId: { type: String, default: "" },
    sessionId: { type: String, default: "" },
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

AnalyticsPurchaseDeliverySchema.index({ status: 1, nextAttemptAt: 1 });

export const AnalyticsPurchaseDelivery =
  models.AnalyticsPurchaseDelivery ??
  model(
    "AnalyticsPurchaseDelivery",
    AnalyticsPurchaseDeliverySchema,
    "analytics_purchase_deliveries",
  );
