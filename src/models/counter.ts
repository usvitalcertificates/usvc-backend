import mongoose from "mongoose";

const { Schema } = mongoose;
const model = mongoose.model.bind(mongoose);
const models = mongoose.models as Record<string, any>;

/** Atomic integer sequences (e.g. the global public order number counter).
 *  Increments via a single findOneAndUpdate $inc, so concurrent orders and
 *  multiple API instances can never receive the same value. */
const CounterSchema = new Schema(
  {
    _id: { type: String, required: true },
    value: { type: Number, required: true, default: 0 },
  },
  { collection: "counters" },
);

export const Counter = models.Counter ?? model("Counter", CounterSchema, "counters");

/** Next value of a named sequence, starting at 1. Throws when unavailable. */
export async function nextSequence(name: string): Promise<number> {
  const doc = await Counter.findOneAndUpdate(
    { _id: name },
    { $inc: { value: 1 } },
    { upsert: true, new: true },
  ).lean();
  if (!doc || !Number.isSafeInteger(doc.value) || doc.value < 1)
    throw new Error(`Sequence ${name} is unavailable.`);
  return doc.value;
}

/** Next global public order number sequence, starting at 1. */
export const nextOrderSequence = () => nextSequence("orderSeq");
