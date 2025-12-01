# Levine Links

Matt Levine's Money Stuff newsletter, enhanced with AI summaries for paywalled articles.

**Live at [levine.fldr.zip](https://levine.fldr.zip)**

## What it does

1. Receives Matt Levine's newsletter via email
2. Extracts all links and resolves tracking URLs
3. Generates AI summaries for paywalled articles (via Perplexity)
4. Finds archived versions on archive.is
5. Injects summaries inline with expandable previews
6. Sends enhanced version to subscribers
7. Hosts web archive of all issues

## Stack

- **Cloudflare Workers** - Edge compute
- **Cloudflare D1** - SQLite database (subscribers)
- **Cloudflare KV** - Newsletter HTML storage
- **Cloudflare Email Workers** - Inbound email handling
- **Resend** - Outbound email delivery
- **Perplexity API** - Article summarization

## Setup

### 1. Clone and install

```bash
git clone https://github.com/fldr-zip/levinelinks
cd levinelinks
bun install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your API keys
```

### 3. Create Cloudflare resources

```bash
# Create D1 database
wrangler d1 create levinelinks-db

# Create KV namespace
wrangler kv:namespace create NEWSLETTERS

# Update wrangler.toml with the IDs from above
```

### 4. Run migrations

```bash
bun run db:migrate:local   # Local dev
bun run db:migrate:prod    # Production
```

### 5. Deploy

```bash
wrangler deploy
```

### 6. Configure email routing

In Cloudflare Dashboard:

1. Go to **Email** → **Email Routing**
2. Add your domain (e.g., `levine.fldr.zip`)
3. Create a **Catch-all** rule → Route to **Worker** → `levinelinks`

### 7. Configure Resend

1. Add your domain in Resend dashboard
2. Set up DNS records (SPF, DKIM, DMARC)
3. Verify domain

## Seeding the archive

To backfill with previous newsletters:

1. Set `SEED_EMAIL` in `.env` to your email
2. Forward old Money Stuff emails to `inbox@levine.fldr.zip`
3. They'll be processed and stored without sending to subscribers

## Local development

```bash
bun run dev
```

This starts the worker locally at `http://localhost:8787`

## Scripts

```bash
bun run test-parser     # Test link extraction
bun run test-wrap       # Test newsletter wrapping (uses LIMIT env var)
bun run test-full       # Full end-to-end test
```

## Environment variables

| Variable               | Description                          |
| ---------------------- | ------------------------------------ |
| `PERPLEXITY_API_KEY`   | Perplexity API key for summaries     |
| `RESEND_API_KEY`       | Resend API key for sending emails    |
| `CLOUDFLARE_API_TOKEN` | CF API token (for wrangler)          |
| `SEED_EMAIL`           | Your email for forwarding old issues |

## License

MIT
