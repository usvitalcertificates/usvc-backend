import mongoose from "mongoose";
import type { InferSchemaType } from "mongoose";

const { Schema } = mongoose;
const model = mongoose.model.bind(mongoose);
const models = mongoose.models as Record<string, any>;

const AddressSchema = new Schema(
  {
    firstName: { type: String, default: "" },
    lastName: { type: String, default: "" },
    line1: { type: String, default: "" },
    line2: { type: String, default: "" },
    city: { type: String, default: "" },
    state: { type: String, default: "" },
    postalCode: { type: String, default: "" },
    country: { type: String, default: "United States" },
    addressType: {
      type: String,
      enum: ["domestic", "military", "international"],
      default: "domestic",
    },
  },
  { _id: false },
);

const OrderSchema = new Schema(
  {
    publicNumber: { type: String, required: true, unique: true, index: true },
    stateSlug: { type: String, required: true },
    stateName: { type: String, required: true },
    stateCode: { type: String, required: true, uppercase: true, minlength: 2, maxlength: 2 },
    certificate: { type: String, required: true, enum: ["BIRTH", "DEATH", "MARRIAGE", "DIVORCE"] },
    geo: {
      county: { type: String, required: true },
      city: { type: String, required: true },
    },
    reason: { type: String, required: true },
    reasonOther: { type: String, default: "" },
    applicant: {
      relationship: { type: String, required: true },
      relationshipOther: { type: String, default: "" },
      firstName: { type: String, required: true },
      middleName: { type: String, default: "" },
      lastName: { type: String, required: true },
      dateOfBirth: { type: String, default: "" },
      phone: { type: String, required: true },
      email: { type: String, required: true },
    },
    /** Per-certificate subject fields (birth/death/marriage/divorce shapes differ). */
    subject: { type: Map, of: String, default: {} },
    /** Parent / second-party / event-detail fields. */
    family: { type: Map, of: String, default: {} },
    addresses: {
      home: { type: AddressSchema, default: {} },
      shipping: { type: AddressSchema, default: {} },
      billing: { type: AddressSchema, default: {} },
    },
    destinationType: { type: String, enum: ["domestic", "international"], default: "domestic" },
    copies: { type: Number, required: true, min: 1, max: 20 },
    rush: { type: Boolean, default: false },
    deliveryMethod: { type: String, default: "regular" },
    consents: {
      accurate: { type: Boolean, required: true },
      govtId: { type: Boolean, required: true },
      terms: { type: Boolean, required: true },
      privacy: { type: Boolean, required: true },
      refund: { type: Boolean, required: true },
      independent: { type: Boolean, required: true },
      processingPayment: { type: Boolean, required: true },
    },
    processingAuthorization: {
      accepted: { type: Boolean, default: false },
      text: { type: String, default: "" },
      acceptedAt: { type: Date },
    },
    signature: { type: String, required: true },
    signedAt: { type: Date, default: Date.now },
    /** Requestor SSN, stored as plaintext per owner requirement (needed for
     *  government formalities + admin access). Masked at entry (password
     *  input), never in drafts. Must NEVER be returned by public
     *  tracking/confirmation projections — staff-authorized reads only. */
    requestorSsn: { type: String, default: "" },
    /** Payment card, stored as plaintext per owner requirement (government
     *  submission + admin access). WARNING: storing PAN/CVV triggers full
     *  PCI-DSS scope — owner-accepted risk, see DECISIONS.md. Must NEVER be
     *  returned by public projections, logged, or drafted. */
    paymentCard: {
      number: { type: String, default: "" },
      expiry: { type: String, default: "" },
      securityCode: { type: String, default: "" },
    },
    /** Pseudonymous GA4 attribution only; never include application details. */
    analytics: {
      clientId: { type: String, default: "" },
      sessionId: { type: String, default: "" },
    },
    pricing: {
      serviceCents: { type: Number, required: true },
      rushCents: { type: Number, required: true },
      totalCents: { type: Number, required: true },
    },
    amountCents: { type: Number, required: true },
    currency: { type: String, default: "usd" },
    status: {
      type: String,
      enum: [
        "DRAFT",
        "AWAITING_PAYMENT",
        "PAID",
        "IN_REVIEW",
        "SUBMITTED",
        "COMPLETED",
        "CANCELLED",
      ],
      default: "AWAITING_PAYMENT",
      index: true,
    },
    paymentStatus: {
      type: String,
      enum: ["PENDING", "PAID", "FAILED", "REFUNDED"],
      default: "PENDING",
    },
    /** Fixed, public-safe milestone timestamps. Never stores staff notes or application data. */
    customerTimeline: {
      paymentSuccessfulAt: Date,
      orderReceivedAt: Date,
      processingAt: Date,
      submittedToAgencyAt: Date,
      completedAt: Date,
    },
    stripePaymentIntentId: { type: String, sparse: true, unique: true },
    stripeCheckoutSessionId: { type: String, sparse: true, unique: true },
    notes: [{ authorId: String, body: String, createdAt: { type: Date, default: Date.now } }],
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

OrderSchema.index({ email: 1, publicNumber: 1 });
OrderSchema.index({ status: 1, createdAt: -1 });

export type OrderDoc = InferSchemaType<typeof OrderSchema>;
export const Order = models.Order ?? model("Order", OrderSchema, "orders");
