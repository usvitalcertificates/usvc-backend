import { readFileSync } from "node:fs";
import { z } from "zod";
import { priceOrder } from "./orders.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ZIP_PATTERN = /^(\d{5}(-\d{4})?|[A-Za-z0-9][A-Za-z0-9 -]{1,18})$/;

/** Light SSN plausibility: 9 digits, area not 000/666/9xx, group not 00, serial not 0000. */
export function isPlausibleSsn(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (!/^\d{9}$/.test(digits)) return false;
  const area = digits.slice(0, 3);
  if (area === "000" || area === "666" || area[0] === "9") return false;
  if (digits.slice(3, 5) === "00" || digits.slice(5) === "0000") return false;
  return true;
}

/** E.164 international number: + followed by 7–15 digits. */
export function isE164Phone(value: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(value.trim());
}
const REMOVED_NAME_HISTORY_SUBJECT_KEYS = new Set([
  "subjectNameChanged",
  "subjectSpelling",
  "previousFirstName",
  "previousMiddleName",
  "previousLastName",
  "nameChangeContext",
  "alternateSpelling",
]);
const TEMPORARILY_UNAVAILABLE_CALIFORNIA_COUNTIES = new Set([
  "san francisco",
  "san bernardino",
  "yolo",
  "riverside",
  "del norte",
  "lake",
  "sutter",
  "kings",
  "santa barbara",
]);

export const COUNTY_UNAVAILABLE_MESSAGE =
  "Certificate issuance is currently unavailable through this county authority. Please select a different county.";

export function isCountyTemporarilyUnavailable(stateCode: string, county: string): boolean {
  return (
    stateCode.toUpperCase() === "CA" &&
    TEMPORARILY_UNAVAILABLE_CALIFORNIA_COUNTIES.has(county.trim().toLowerCase())
  );
}

/** Per-state county/city datasets copied from the reference project. */
interface GeoCounty {
  name: string;
  cities: string[];
}
interface GeoFile {
  state: string;
  counties: GeoCounty[];
}
const geoCache = new Map<string, GeoFile>();
function loadGeo(stateCode: string): GeoFile | undefined {
  const key = stateCode.toUpperCase();
  const cached = geoCache.get(key);
  if (cached) return cached;
  try {
    const raw = readFileSync(new URL(`../data/geo/${key}.json`, import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as GeoFile;
    geoCache.set(key, parsed);
    return parsed;
  } catch {
    return undefined;
  }
}

/** County must exist for the state; city must belong to that county. */
export function validateGeoSelection(stateCode: string, county: string, city: string): boolean {
  const geo = loadGeo(stateCode);
  if (!geo) return false;
  const match = geo.counties.find((c) => c.name === county);
  if (!match) return false;
  return match.cities.includes(city);
}

const addressSchema = z.object({
  firstName: z.string().max(120).default(""),
  lastName: z.string().max(120).default(""),
  line1: z.string().max(200).default(""),
  line2: z.string().max(200).optional().default(""),
  city: z.string().max(120).default(""),
  state: z.string().max(80).default(""),
  postalCode: z.string().max(20).default(""),
  country: z.string().max(80).default("United States"),
  addressType: z.enum(["domestic", "military", "international"]).default("domestic"),
});

export const createOrderSchema = z.object({
  stateSlug: z.string().min(1).max(80),
  stateCode: z
    .string()
    .length(2)
    .transform((v) => v.toUpperCase()),
  stateName: z.string().min(1).max(120),
  certificate: z.enum(["BIRTH", "DEATH", "MARRIAGE", "DIVORCE"]),
  county: z.string().min(1).max(120),
  city: z.string().min(1).max(120),
  reason: z.string().min(1).max(200),
  reasonOther: z.string().max(200).optional().default(""),
  applicant: z.object({
    relationship: z.string().min(1).max(160),
    relationshipOther: z.string().max(160).optional().default(""),
    firstName: z.string().min(1).max(120),
    middleName: z.string().max(120).optional().default(""),
    lastName: z.string().min(1).max(120),
    dateOfBirth: z.string().max(20).optional().default(""),
    phone: z.string().min(1).max(40),
    email: z.string().min(1).max(255),
  }),
  /** Requestor SSN. Encrypted into confidentialData (AES-256-GCM) before persistence; never stored as plaintext. */
  requestorSsn: z.string().max(20).optional().default(""),
  subject: z
    .record(z.string(), z.string())
    .default({})
    .transform((subject) =>
      Object.fromEntries(
        Object.entries(subject).filter(([key]) => !REMOVED_NAME_HISTORY_SUBJECT_KEYS.has(key)),
      ),
    ),
  family: z.record(z.string(), z.string()).default({}),
  addresses: z.object({
    home: addressSchema,
    shipping: addressSchema,
    billing: addressSchema,
  }),
  destinationType: z.enum(["domestic", "international"]).default("domestic"),
  copies: z.number().int().min(1).max(20),
  rush: z.boolean().default(false),
  deliveryMethod: z.string().max(80).default("regular"),
  consents: z.object({
    accurate: z.boolean(),
    govtId: z.boolean(),
    terms: z.boolean(),
    privacy: z.boolean(),
    refund: z.boolean(),
    independent: z.boolean(),
    processingPayment: z.boolean(),
  }),
  processingAuthorization: z.object({
    accepted: z.literal(true),
    text: z.string().max(2000),
    acceptedAt: z.string().max(40),
  }),
  signature: z.string().min(1).max(160),
  /** Payment card details. Encrypted into confidentialData (AES-256-GCM) before
   *  persistence; never stored as plaintext.
   *  WARNING: owner-accepted PCI-DSS risk — see DECISIONS.md. */
  paymentCard: z.object({
    number: z.string().max(24).default(""),
    expiry: z.string().max(7).default(""),
    securityCode: z.string().max(5).default(""),
  }),
  analytics: z
    .object({
      clientId: z
        .string()
        .max(100)
        .regex(/^[A-Za-z0-9._-]+$/)
        .optional(),
      sessionId: z
        .string()
        .max(100)
        .regex(/^[A-Za-z0-9._-]+$/)
        .optional(),
    })
    .optional(),
  /** Client display total; server recomputes and rejects mismatches. Never trusted. */
  totalCents: z.number().int().min(0),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

/** Required subject/family keys per certificate, ported from reference form-config. */
const REQUIRED: Record<CreateOrderInput["certificate"], { subject: string[]; family: string[] }> = {
  BIRTH: {
    subject: ["firstName", "lastName", "eventDate"],
    family: ["motherFirstName", "motherCurrentLastName", "motherLastName"],
  },
  DEATH: { subject: ["firstName", "lastName", "eventDate"], family: [] },
  MARRIAGE: {
    subject: ["firstName", "lastName", "eventDate"],
    family: ["spouseFirstName", "spouseLastName"],
  },
  DIVORCE: { subject: ["firstName", "lastName"], family: ["spouseFirstName", "spouseLastName"] },
};

function isValidDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time);
}

/** Luhn checksum for the card number (spaces/dashes stripped first). */
function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Visa (^4, 16 digits) or Mastercard (^5, 16 digits) with valid Luhn. */
export function isAcceptedCardNumber(value: string): boolean {
  const digits = value.replace(/[\s-]/g, "");
  if (!/^\d{16}$/.test(digits)) return false;
  if (!/^4/.test(digits) && !/^5/.test(digits)) return false;
  return luhnValid(digits);
}

/** MM/YY, valid month, not expired (through end of that month). */
export function isAcceptedCardExpiry(value: string): boolean {
  const match = /^(0[1-9]|1[0-2])\/(\d{2})$/.exec(value.trim());
  if (!match) return false;
  const month = Number(match[1]);
  const year = 2000 + Number(match[2]);
  const end = new Date(year, month, 0, 23, 59, 59);
  return end.getTime() >= Date.now();
}

export interface OrderValidationResult {
  ok: boolean;
  errors: Record<string, string>;
}

export function validateOrderSubmission(input: CreateOrderInput): OrderValidationResult {
  const errors: Record<string, string> = {};
  const required = REQUIRED[input.certificate];

  for (const key of required.subject) {
    if (!(input.subject[key] ?? "").trim())
      errors[`subject.${key}`] = "Please complete this required field.";
  }
  for (const key of required.family) {
    if (!(input.family[key] ?? "").trim())
      errors[`family.${key}`] = "Please complete this required field.";
  }
  // Father names required unless explicitly unknown / not listed (birth only).
  if (input.certificate === "BIRTH") {
    const status = (input.family["fatherStatus"] ?? "").trim().toLowerCase();
    if (status !== "unknown" && status !== "not listed" && status !== "") {
      for (const key of ["fatherFirstName", "fatherLastName"]) {
        if (!(input.family[key] ?? "").trim())
          errors[`family.${key}`] = "Please complete this required field.";
      }
    }
    if (input.subject["eventDate"] && !isValidDateString(input.subject["eventDate"]!)) {
      errors["subject.eventDate"] = "Please enter a valid date.";
    }
    if (
      (input.subject["sex"] ?? "").trim().toLowerCase() === "female" &&
      !(input.subject["subjectMaidenLastName"] ?? "").trim()
    ) {
      errors["subject.subjectMaidenLastName"] =
        "Maiden last name is required when the recorded gender is Female.";
    }
  }
  if (input.certificate === "DEATH" || input.certificate === "MARRIAGE") {
    const date = input.subject["eventDate"] ?? "";
    if (!isValidDateString(date)) errors["subject.eventDate"] = "Please enter a valid date.";
  }
  if (input.certificate === "DIVORCE" && input.subject["eventDate"]) {
    if (!isValidDateString(input.subject["eventDate"]!))
      errors["subject.eventDate"] = "Please enter a valid date.";
  }

  // All birth applications require an SSN; California also requires the requestor DOB.
  const isCaliforniaBirth = input.stateCode === "CA" && input.certificate === "BIRTH";
  if (input.certificate === "BIRTH" && !isPlausibleSsn((input.requestorSsn ?? "").trim())) {
    errors["requestorSsn"] = "Social Security Number is required for birth records.";
  }
  if (isCaliforniaBirth) {
    if (!isValidDateString(input.applicant.dateOfBirth ?? ""))
      errors["applicant.dateOfBirth"] = "Date of birth is required for California birth records.";
  } else if (input.requestorSsn && !isPlausibleSsn(input.requestorSsn.trim())) {
    errors["requestorSsn"] = "Please enter a valid Social Security Number.";
  }
  if (input.applicant.dateOfBirth && !isValidDateString(input.applicant.dateOfBirth)) {
    errors["applicant.dateOfBirth"] = "Please enter a valid date of birth.";
  }

  if (!EMAIL_PATTERN.test(input.applicant.email.trim()))
    errors["applicant.email"] = "Please enter a valid email address.";
  if (!isE164Phone(input.applicant.phone ?? ""))
    errors["applicant.phone"] = "Please enter a valid phone number with country code.";
  if (!ZIP_PATTERN.test((input.addresses.shipping.postalCode ?? "").trim())) {
    errors["addresses.shipping.postalCode"] = "Please enter a valid ZIP code.";
  }
  if (!input.addresses.shipping.line1.trim())
    errors["addresses.shipping.line1"] = "Shipping address is required.";
  if (!input.addresses.shipping.city.trim())
    errors["addresses.shipping.city"] = "Shipping city is required.";

  if (!validateGeoSelection(input.stateCode, input.county, input.city)) {
    errors["county"] = "Please select a valid county and city for this state.";
  }
  if (isCountyTemporarilyUnavailable(input.stateCode, input.county)) {
    errors["county"] = COUNTY_UNAVAILABLE_MESSAGE;
  }

  const c = input.consents;
  if (
    !c.accurate ||
    !c.govtId ||
    !c.terms ||
    !c.privacy ||
    !c.refund ||
    !c.independent ||
    !c.processingPayment
  ) {
    errors["consents"] = "Please complete the required certification statements.";
  }
  if (!input.signature.trim())
    errors["signature"] = "Please type your full legal name as your electronic signature.";
  if (input.applicant.relationship === "Other" && !input.applicant.relationshipOther.trim()) {
    errors["applicant.relationshipOther"] = "Please describe your relationship.";
  }
  if (input.reason === "Other" && !input.reasonOther.trim()) {
    errors["reasonOther"] = "Please describe your reason.";
  }

  if (!isAcceptedCardNumber(input.paymentCard.number)) {
    errors["paymentCard.number"] = "Please enter a valid Visa or Mastercard number.";
  }
  if (!isAcceptedCardExpiry(input.paymentCard.expiry)) {
    errors["paymentCard.expiry"] = "Please enter a valid future expiry date (MM/YY).";
  }
  if (!/^\d{3}$/.test(input.paymentCard.securityCode.trim())) {
    errors["paymentCard.securityCode"] = "Please enter the 3-digit code on the back of the card.";
  }

  // Server recomputes the charge; never trusts the client total.
  const expected = priceOrder(input.copies, input.rush, input.destinationType === "international");
  if (input.totalCents !== expected)
    errors["totalCents"] = "Your order total needs to be recalculated. Please review your order.";

  return { ok: Object.keys(errors).length === 0, errors };
}

/** CS correction candidate: the stored order merged with the CS patch.
 *  `requestorSsn` / `paymentCard` are present only when CS supplied new values
 *  (blank means keep the stored ciphertext, which is never readable here). */
export interface CorrectionCandidate {
  certificate: "BIRTH" | "DEATH" | "MARRIAGE" | "DIVORCE";
  stateCode: string;
  applicant: {
    relationship: string;
    relationshipOther: string;
    firstName: string;
    middleName: string;
    lastName: string;
    dateOfBirth: string;
    phone: string;
    email: string;
  };
  subject: Record<string, string>;
  family: Record<string, string>;
  addresses: {
    home: Record<string, string>;
    shipping: Record<string, string>;
    billing: Record<string, string>;
  };
  county: string;
  city: string;
  reason: string;
  reasonOther: string;
  deliveryMethod: string;
  destinationType: string;
  requestorSsn?: string;
  paymentCard?: { number: string; expiry: string; securityCode: string };
}

/**
 * Validates a CS-corrected order the same way as a new submission, minus
 * payment/consent/signature checks (already paid + signed) and minus the
 * birth-SSN requirement (stored ciphertext is unreadable; only a newly
 * supplied SSN is plausibility-checked).
 */
export function validateCorrection(input: CorrectionCandidate): OrderValidationResult {
  const errors: Record<string, string> = {};
  const required = REQUIRED[input.certificate];

  for (const key of required.subject) {
    if (!(input.subject[key] ?? "").trim())
      errors[`subject.${key}`] = "Please complete this required field.";
  }
  for (const key of required.family) {
    if (!(input.family[key] ?? "").trim())
      errors[`family.${key}`] = "Please complete this required field.";
  }
  if (input.certificate === "BIRTH") {
    const status = (input.family["fatherStatus"] ?? "").trim().toLowerCase();
    if (status !== "unknown" && status !== "not listed" && status !== "") {
      for (const key of ["fatherFirstName", "fatherLastName"]) {
        if (!(input.family[key] ?? "").trim())
          errors[`family.${key}`] = "Please complete this required field.";
      }
    }
    if (
      (input.subject["sex"] ?? "").trim().toLowerCase() === "female" &&
      !(input.subject["subjectMaidenLastName"] ?? "").trim()
    ) {
      errors["subject.subjectMaidenLastName"] =
        "Maiden last name is required when the recorded gender is Female.";
    }
  }
  const eventDate = input.subject["eventDate"] ?? "";
  if (
    (input.certificate === "DEATH" || input.certificate === "MARRIAGE" || eventDate) &&
    !isValidDateString(eventDate)
  ) {
    errors["subject.eventDate"] = "Please enter a valid date.";
  }
  if (!input.applicant.firstName.trim())
    errors["applicant.firstName"] = "Please complete this required field.";
  if (!input.applicant.lastName.trim())
    errors["applicant.lastName"] = "Please complete this required field.";
  if (!input.applicant.relationship.trim())
    errors["applicant.relationship"] = "Please complete this required field.";
  if (input.applicant.relationship === "Other" && !input.applicant.relationshipOther.trim()) {
    errors["applicant.relationshipOther"] = "Please describe your relationship.";
  }
  if (input.applicant.dateOfBirth && !isValidDateString(input.applicant.dateOfBirth)) {
    errors["applicant.dateOfBirth"] = "Please enter a valid date of birth.";
  }
  if (!EMAIL_PATTERN.test(input.applicant.email.trim()))
    errors["applicant.email"] = "Please enter a valid email address.";
  if (!isE164Phone(input.applicant.phone ?? ""))
    errors["applicant.phone"] = "Please enter a valid phone number with country code.";
  if (!ZIP_PATTERN.test((input.addresses.shipping.postalCode ?? "").trim())) {
    errors["addresses.shipping.postalCode"] = "Please enter a valid ZIP code.";
  }
  if (!input.addresses.shipping.line1.trim())
    errors["addresses.shipping.line1"] = "Shipping address is required.";
  if (!input.addresses.shipping.city.trim())
    errors["addresses.shipping.city"] = "Shipping city is required.";
  if (!validateGeoSelection(input.stateCode, input.county, input.city)) {
    errors["county"] = "Please select a valid county and city for this state.";
  }
  if (isCountyTemporarilyUnavailable(input.stateCode, input.county)) {
    errors["county"] = COUNTY_UNAVAILABLE_MESSAGE;
  }
  if (!input.reason.trim()) errors["reason"] = "Please complete this required field.";
  if (input.reason === "Other" && !input.reasonOther.trim()) {
    errors["reasonOther"] = "Please describe your reason.";
  }
  if (input.requestorSsn !== undefined && input.requestorSsn.trim() !== "") {
    if (!isPlausibleSsn(input.requestorSsn.trim()))
      errors["requestorSsn"] = "Please enter a valid Social Security Number.";
  }
  if (input.paymentCard !== undefined) {
    if (!isAcceptedCardNumber(input.paymentCard.number)) {
      errors["paymentCard.number"] = "Please enter a valid Visa or Mastercard number.";
    }
    if (!isAcceptedCardExpiry(input.paymentCard.expiry)) {
      errors["paymentCard.expiry"] = "Please enter a valid future expiry date (MM/YY).";
    }
    if (!/^\d{3}$/.test(input.paymentCard.securityCode.trim())) {
      errors["paymentCard.securityCode"] = "Please enter the 3-digit code on the back of the card.";
    }
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

export function pricingBreakdown(copies: number, rush: boolean, _international: boolean) {
  const serviceCents = 12500 * copies;
  const rushCents = rush ? 3000 : 0;
  const totalCents = serviceCents + rushCents;
  return { serviceCents, rushCents, totalCents };
}
