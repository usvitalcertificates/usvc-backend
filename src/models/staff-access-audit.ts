import mongoose from "mongoose";

const schema = new mongoose.Schema({
  actorId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: "StaffUser" },
  action: { type: String, required: true },
  references: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now, index: true },
});
schema.index({ actorId: 1, createdAt: -1 });
export type StaffAccessAuditDoc = mongoose.InferSchemaType<typeof schema>;
export const StaffAccessAudit =
  (mongoose.models.StaffAccessAudit as mongoose.Model<StaffAccessAuditDoc> | undefined) ??
  mongoose.model<StaffAccessAuditDoc>("StaffAccessAudit", schema, "staff_access_audit");
