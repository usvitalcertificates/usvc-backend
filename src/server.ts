import { app } from "./app.js";
import { env } from "./config/env.js";
import { connectDb } from "./lib/db.js";
import { migrateStaffRoles } from "./lib/staff-role-migration.js";
import { startEmailOutboxWorker } from "./lib/email-outbox.js";
import { startAnalyticsOutboxWorker } from "./lib/analytics-outbox.js";
connectDb()
  .then(async () => {
    const { migrated } = await migrateStaffRoles().catch((error) => {
      console.error("Staff role migration failed", error);
      return { migrated: 0 };
    });
    if (migrated > 0) console.log(`Migrated ${migrated} staff role(s) STAFF → FULFILLMENT`);
    return app.listen(env.PORT, () => {
      startEmailOutboxWorker();
      startAnalyticsOutboxWorker();
      console.log(`USVC API listening on ${env.PORT}`);
    });
  })
  .catch((error) => {
    console.error("MongoDB startup failed", error);
    process.exit(1);
  });
