import mongoose from "mongoose";
const { Schema } = mongoose;
const grantSchema = new Schema(
  {
    tokenHash: { type: String, required: true, unique: true, select: false },
    email: { type: String, required: true },
    orderId: { type: Schema.Types.ObjectId },
    source: { type: String, enum: ["SELF", "STAFF"], required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
    lastCodeAt: Date,
  },
  { timestamps: true },
);
grantSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
grantSchema.index({ orderId: 1, source: 1 });
const challengeSchema = new Schema(
  {
    grantId: { type: Schema.Types.ObjectId, required: true, index: true },
    codeHash: { type: String, required: true, select: false },
    attempts: { type: Number, default: 0 },
    usedAt: Date,
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);
challengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const sessionSchema = new Schema(
  {
    tokenHash: { type: String, required: true, unique: true, select: false },
    grantId: { type: Schema.Types.ObjectId, required: true },
    email: { type: String, required: true },
    orderId: Schema.Types.ObjectId,
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const limitSchema = new Schema({
  _id: String,
  count: { type: Number, default: 0 },
  expiresAt: Date,
});
limitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const auditSchema = new Schema({
  actor: String,
  action: String,
  references: [String],
  createdAt: { type: Date, default: Date.now },
});
export const RecoveryGrant =
  mongoose.models.RecoveryGrant ?? mongoose.model("RecoveryGrant", grantSchema, "recovery_grants");
export const RecoveryChallenge =
  mongoose.models.RecoveryChallenge ??
  mongoose.model("RecoveryChallenge", challengeSchema, "recovery_challenges");
export const RecoverySession =
  mongoose.models.RecoverySession ??
  mongoose.model("RecoverySession", sessionSchema, "recovery_sessions");
export const RecoveryLimit =
  mongoose.models.RecoveryLimit ?? mongoose.model("RecoveryLimit", limitSchema, "recovery_limits");
export const RecoveryAudit =
  mongoose.models.RecoveryAudit ?? mongoose.model("RecoveryAudit", auditSchema, "recovery_audit");
