import mongoose from "mongoose";

const { Schema } = mongoose;
const model = mongoose.model.bind(mongoose);
const models = mongoose.models as Record<string, any>;

const OpenAIConversionDeliverySchema = new Schema(
  {
    _id: { type: String, required: true },
    orderId: { type: Schema.Types.ObjectId, required: true, unique: true, index: true },
    eventId: { type: String, required: true, unique: true },
    occurredAt: { type: Date, required: true },
    amountCents: { type: Number, required: true },
    currency: { type: String, required: true },
    certificate: { type: String, required: true },
    copies: { type: Number, required: true },
    oppref: { type: String, default: "" },
    obref: { type: String, default: "" },
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

OpenAIConversionDeliverySchema.index({ status: 1, nextAttemptAt: 1 });

export const OpenAIConversionDelivery =
  models.OpenAIConversionDelivery ??
  model("OpenAIConversionDelivery", OpenAIConversionDeliverySchema, "openai_conversion_deliveries");
