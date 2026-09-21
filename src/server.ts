import { app } from "./app.js";
import { env } from "./config/env.js";
import { connectDb } from "./lib/db.js";
connectDb()
  .then(() => app.listen(env.PORT, () => console.log(`USVC API listening on ${env.PORT}`)))
  .catch((error) => {
    console.error("MongoDB startup failed", error);
    process.exit(1);
  });
