/**
 * Testing helper (LOCAL DEV ONLY): reset all SUBMITTED orders back to PAID
 * unassigned so the fulfillment loop can be tested again.
 *
 * SUBMITTED is terminal in the API — no status endpoint moves backward —
 * so this scripted, audited reset is the only way back.
 *
 * Usage:
 *   npx tsx scripts/reset-submitted-for-testing.ts          # dry run (default)
 *   npx tsx scripts/reset-submitted-for-testing.ts --apply  # perform the reset
 *
 * Refuses to run with NODE_ENV=production or a prod-looking DB name.
 * Never prints secrets or connection strings.
 */
import "dotenv/config";
import { connectDb, mongoose } from "../src/lib/db.js";
import { Order } from "../src/models/order.js";
import { EmailOutbox } from "../src/models/email-outbox.js";

const apply = process.argv.includes("--apply");

function dbLabel(): string {
  const db = process.env.MONGODB_DB_NAME || "usvc";
  let host = "(unknown host)";
  try {
    host = new URL(process.env.MONGODB_URI || "").host;
  } catch {
    /* keep placeholder */
  }
  return `${host} / ${db}`;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to run with NODE_ENV=production.");
    process.exit(1);
  }
  const dbName = process.env.MONGODB_DB_NAME || "usvc";
  if (/prod/i.test(dbName) && !process.argv.includes("--force")) {
    console.error(`Refusing to touch prod-looking DB "${dbName}" without --force.`);
    process.exit(1);
  }

  await connectDb();
  const submitted = await Order.find({ status: "SUBMITTED" }, { publicNumber: 1 }).lean();
  console.log(`Target DB: ${dbLabel()}`);
  console.log(`SUBMITTED orders found: ${submitted.length}`);
  for (const o of submitted.slice(0, 50)) console.log(`  - ${o.publicNumber}`);
  if (submitted.length > 50) console.log(`  …and ${submitted.length - 50} more`);

  if (!apply) {
    console.log("Dry run only — no writes. Re-run with --apply to reset.");
    return;
  }

  const now = new Date();
  const ids = submitted.map((o) => o._id);
  const res = await Order.updateMany(
    { status: "SUBMITTED" },
    {
      $set: { status: "PAID", assignedTo: null },
      $unset: { "customerTimeline.submittedToAgencyAt": 1, "customerTimeline.processingAt": 1 },
      $push: {
        auditEvents: {
          actorId: "testing-reset",
          action: "order_reopened_for_testing",
          metadata: { from: "SUBMITTED", to: "PAID" },
          createdAt: now,
        },
      },
    },
  );
  const outbox = await EmailOutbox.deleteMany({
    orderId: { $in: ids },
    template: "SUBMISSION_NOTIFICATION",
    status: { $in: ["PENDING", "SENDING"] },
  });
  console.log(
    `Reset done: matched=${res.matchedCount} modified=${res.modifiedCount} ` +
      `staleSubmissionJobsDeleted=${outbox.deletedCount}`,
  );
}

main()
  .catch((e) => {
    console.error("Reset failed:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => undefined);
  });
