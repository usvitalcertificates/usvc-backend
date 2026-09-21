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

On startup, the API connects to MongoDB and creates safe indexes. Health is at `http://localhost:4000/health`.

## 3. Verify

```bash
npm run build
npm test
```

If startup fails with an `_id index` error, ensure the index bootstrap does not attempt to create an explicit `_id` index. MongoDB creates that index automatically.
