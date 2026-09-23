import mongoose from "mongoose";

const { Schema } = mongoose;
const model = mongoose.model.bind(mongoose);
const models = mongoose.models as Record<string, any>;

const StaffUserSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, index: true },
    fullName: { type: String, default: "" },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ["ADMIN", "STAFF"], required: true },
    accountStatus: {
      type: String,
      enum: ["pending", "active", "disabled", "blocked"],
      default: "active",
      index: true,
    },
    /** Single-use invitation token (sha256 hex). Cleared on setup. */
    inviteTokenHash: { type: String, select: false },
    inviteExpiresAt: { type: Date },
    /** TOTP secret, AES-256-GCM ciphertext via SENSITIVE_ENCRYPTION_KEY. */
    mfaSecret: { type: String, select: false },
    mfaEnabled: { type: Boolean, default: false },
    mfaEnrolledAt: { type: Date },
    mfaLastVerifiedAt: { type: Date },
    refreshTokenHash: { type: String, select: false },
    /** Revokes sessions/tokens issued before this time. */
    sessionsRevokedAt: { type: Date },
    failedLoginAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date },
    lastLoginAt: { type: Date },
    lastActivityAt: { type: Date },
    auditEvents: [
      {
        actorId: String,
        action: String,
        metadata: Schema.Types.Mixed,
        createdAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true },
);

export const StaffUser = models.StaffUser ?? model("StaffUser", StaffUserSchema, "staff_users");

const StripeEventSchema = new Schema({
  _id: { type: String, required: true },
  type: { type: String, required: true },
  orderId: { type: Schema.Types.ObjectId },
  receivedAt: { type: Date, default: Date.now },
});

export const StripeEvent =
  models.StripeEvent ?? model("StripeEvent", StripeEventSchema, "stripe_events");

const GovernmentFeeSchema = new Schema(
  {
    stateCode: { type: String, required: true, uppercase: true },
    certificate: { type: String, required: true, enum: ["BIRTH", "DEATH", "MARRIAGE", "DIVORCE"] },
    amountCents: { type: Number, required: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: { createdAt: false, updatedAt: true } },
);

GovernmentFeeSchema.index({ stateCode: 1, certificate: 1 }, { unique: true });

export const GovernmentFee =
  models.GovernmentFee ?? model("GovernmentFee", GovernmentFeeSchema, "government_fees");

const AttendanceRecordSchema = new Schema({
  staffId: { type: Schema.Types.ObjectId, required: true },
  workDate: { type: Date, required: true },
  clockIn: { type: Date },
  clockOut: { type: Date },
  note: { type: String },
});

AttendanceRecordSchema.index({ staffId: 1, workDate: 1 }, { unique: true });

export const AttendanceRecord =
  models.AttendanceRecord ??
  model("AttendanceRecord", AttendanceRecordSchema, "attendance_records");
