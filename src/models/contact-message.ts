import mongoose from "mongoose";

const { Schema } = mongoose;
const model = mongoose.model.bind(mongoose);
const models = mongoose.models as Record<string, any>;

const ContactMessageSchema = new Schema(
  {
    fullName: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    orderNumber: { type: String, default: "", trim: true },
    message: { type: String, required: true, trim: true },
    sensitiveContentWarning: { type: Boolean, default: false },
    status: { type: String, enum: ["NEW"], default: "NEW", index: true },
    emailEvents: [
      {
        action: String,
        metadata: Schema.Types.Mixed,
        createdAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true },
);

ContactMessageSchema.index({ createdAt: -1 });
ContactMessageSchema.index({ email: 1, createdAt: -1 });
ContactMessageSchema.index({ orderNumber: 1, createdAt: -1 });

export const ContactMessage =
  models.ContactMessage ?? model("ContactMessage", ContactMessageSchema, "contact_messages");
