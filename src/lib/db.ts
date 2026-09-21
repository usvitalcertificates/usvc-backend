import mongoose from "mongoose";
import { env } from "../config/env.js";

let ready: Promise<typeof mongoose> | undefined;

/** Single shared Mongoose connection. Call once at startup; models import this. */
export async function connectDb(): Promise<typeof mongoose> {
  if (!ready) ready = mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB_NAME });
  return ready;
}

export { mongoose };
