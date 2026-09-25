# Local backend development

## 1. Create your environment file

```bash
cp .env.example .env
```

Set each value in `.env`; do not commit this file. Use an Atlas connection string that begins with `mongodb+srv://` and a database name such as `usvc`.

Use Stripe **test** keys locally. Obtain the webhook secret from the Stripe CLI forwarding command or from the test webhook endpoint in Stripe Dashboard.

## 2. Install and run

```bash
npm install
npm run dev
```

Always test with `npm run dev` (auto-reloads current source). `npm start`
serves the last built `dist/` output — rebuild first (`npm run build`) or
you will silently test stale code.

On startup, the API connects to MongoDB and creates safe indexes. Health is at `http://localhost:4000/health`.

## 3. Verify

```bash
npm run build
npm test
```

If startup fails with an `_id index` error, ensure the index bootstrap does not attempt to create an explicit `_id` index. MongoDB creates that index automatically.

## 4. Staff portal local test

`EMAIL_ENABLED` defaults to `false` locally, so invites return a manual setup token instead of sending email.

1. Seed one super-admin in `staff_users` (`email`, Argon2 `passwordHash`, `role: "ADMIN"`, `accountStatus: "active"`). Generate the hash with `npx tsx -e "import('argon2').then(async (a) => console.log(await a.hash('your-12-plus-char-password')))"` — never store plaintext.
2. Run the frontend (`API_URL=http://localhost:4000`) and open `http://localhost:3000/auth`: sign in, scan the QR pairing with an authenticator app, enter the 6-digit code.
3. Invite an agent from `/staff/admin`, open the returned setup link in an incognito window, and complete setup with a second authenticator entry.
4. The queue lists paid orders only; locally, submit applications through the public form and set `status` + `paymentStatus` to `PAID` directly in MongoDB to simulate completed checkout (Stripe webhooks cover this on staging).
