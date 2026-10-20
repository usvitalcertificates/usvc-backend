import { z } from "zod";
import { env } from "../config/env.js";
import { connectDb, mongoose } from "../lib/db.js";
import { EmailDispatch } from "../models/email-dispatch.js";
import { EmailOutbox } from "../models/email-outbox.js";
import { reconcileEmailDispatch } from "../lib/email-outbox.js";

/** Read-only reporting or evidence-based reconciliation. This command never dispatches email. */
async function main() {
  const command = z.enum(["report", "reconcile"]).parse(process.argv[2] ?? "report");
  await connectDb();
  if (command === "reconcile") {
    const id = z.string().min(1).max(256).parse(process.argv[3]);
    for (const key of [
      "ZOHO_EMAIL_AGENT_KEY",
      "ZOHO_OAUTH_CLIENT_ID",
      "ZOHO_OAUTH_CLIENT_SECRET",
      "ZOHO_OAUTH_REFRESH_TOKEN",
    ] as const)
      if (!env[key]) throw new Error("Email log credentials are required");
    await reconcileEmailDispatch(id, true);
    const row = await EmailDispatch.findById(id)
      .select("_id provider state reason providerMessageId finalizedAt")
      .lean();
    console.log(JSON.stringify(row ?? { result: "not-found" }));
    return;
  }
  const counts = await EmailDispatch.aggregate([
    { $group: { _id: { provider: "$provider", state: "$state" }, count: { $sum: 1 } } },
  ]);
  const review = await EmailDispatch.find({
    state: { $in: ["DISPATCHING", "UNCERTAIN", "REVIEW"] },
  })
    .select("_id provider state reason startedAt deadlineAt nextReconcileAt")
    .sort({ createdAt: 1 })
    .limit(100)
    .lean();
  const legacy = await EmailOutbox.aggregate([
    { $match: { status: { $in: ["PENDING", "SENDING"] }, attempts: { $gt: 0 } } },
    {
      $lookup: { from: "email_dispatches", localField: "_id", foreignField: "_id", as: "dispatch" },
    },
    { $match: { dispatch: { $size: 0 } } },
    { $project: { _id: 1, template: 1, status: 1, attempts: 1 } },
    { $limit: 100 },
  ]);
  console.log(JSON.stringify({ counts, review, legacyAttemptedJobs: legacy, sampleLimit: 100 }));
}
main()
  .catch(() => {
    console.error(
      "Email operations failed; verify command, database connectivity and Zoho log credentials.",
    );
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
