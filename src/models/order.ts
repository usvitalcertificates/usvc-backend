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
    /** Staff owner for the assigned-agent reveal rule. Null = unassigned queue. */
    assignedTo: { type: Schema.Types.ObjectId, ref: "StaffUser", default: null, index: true },
    /** Encrypted SSN + payment card (AES-256-GCM, see src/lib/crypto.ts).
     *  Ciphertext only — never indexed, never in public projections, never
     *  logged. Staff see `*********` until an audited reveal. Storing PAN and
     *  especially CVC is owner-accepted PCI-DSS risk, see DECISIONS.md. */
    confidentialData: {
      ssnEnc: { type: String, default: "" },
      cardNumberEnc: { type: String, default: "" },
      cardExpiryEnc: { type: String, default: "" },
      cardCvcEnc: { type: String, default: "" },
      keyId: { type: String, default: "v1" },
      encryptedAt: { type: Date },
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
        "TO_CS",
        "GTG",
        "SUBMITTED",
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
    /**
     * Optional MILES-parity reason picked when an order is parked To CS.
     * Cleared on any other move; history survives in audit metadata.
     */
    substatus: { type: String, default: null },
    /**
     * Single completion PDF (GridFS `order_docs` bucket). Required from
     * fulfillment before SUBMITTED; ADMIN bypasses the gate.
     */
    document: {
      type: new Schema(
        {
          fileId: Schema.Types.ObjectId,
          name: String,
          size: Number,
          uploadedBy: String,
          uploadedAt: Date,
        },
        { _id: false },
      ),
    },
    /** Fixed, public-safe milestone timestamps. Never stores staff notes or application data. */
    customerTimeline: {
      paymentSuccessfulAt: Date,
      orderReceivedAt: Date,
      processingAt: Date,
      submittedToAgencyAt: Date,
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
OrderSchema.index({ "auditEvents.actorId": 1, "auditEvents.createdAt": -1 });

export type OrderDoc = InferSchemaType<typeof OrderSchema>;
export const Order = models.Order ?? model("Order", OrderSchema, "orders");
