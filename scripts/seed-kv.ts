import PostalMime from "postal-mime";
import { wrapNewsletter } from "../src/services/wrapper";
import { stripForwardedHeaders } from "../src/services/parser";
import type { Env } from "../src/types";

const EML_PATH =
  process.argv[2] || "./Money Stuff: Take the Crypto Out of the Indexes.eml";
const FETCHER_BASE_URL = process.env.FETCHER_BASE_URL || "http://localhost:8787";
const D1_DATABASE_NAME = process.env.D1_DATABASE_NAME || "levinelinks-db";

async function main() {
  const perplexityKey = process.env.PERPLEXITY_API_KEY;
  if (!perplexityKey) {
    console.error("Missing PERPLEXITY_API_KEY");
    process.exit(1);
  }

  console.log("📧 Parsing email...");
  const file = Bun.file(EML_PATH);
  const raw = await file.text();

  const parser = new PostalMime();
  const parsed = await parser.parse(raw);

  const rawHtml = parsed.html || parsed.text || "";
  const originalHtml = stripForwardedHeaders(rawHtml);
  const subject = (parsed.subject || "Money Stuff")
    .replace(/^(Fwd?:\s*)+/gi, "")
    .trim();

  // Extract date from newsletter URL or use email date
  const urlDateMatch = rawHtml.match(/\/(\d{4}-\d{2}-\d{2})\//);
  const date =
    urlDateMatch?.[1] ||
    (parsed.date
      ? new Date(parsed.date).toISOString().split("T")[0]
      : new Date().toISOString().split("T")[0]);

  console.log(`   Subject: ${subject}`);
  console.log(`   Date: ${date}`);
  console.log("\n🔄 Processing newsletter (this may take a while)...");

  const result = await wrapNewsletter(originalHtml, createScriptEnv(perplexityKey));

  // Save locally for preview
  const previewHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${subject} - Preview</title>
</head>
<body>
${result.html}
</body>
</html>`;

  await Bun.write("./wrapped-preview.html", previewHtml);
  console.log("\n📝 Saved preview to wrapped-preview.html");

  console.log("\n☁️  Uploading to Cloudflare D1...");

  const metadataSql = `
    INSERT INTO newsletters (date, subject, html, preview, og_image, processed_at)
    VALUES (${toSqlString(date)}, ${toSqlString(subject)}, ${toSqlString(result.html)}, ${toSqlString(result.preview)}, ${toSqlString(result.ogImage)}, unixepoch())
    ON CONFLICT(date) DO UPDATE SET
      subject = excluded.subject,
      html = excluded.html,
      preview = excluded.preview,
      og_image = excluded.og_image,
      processed_at = excluded.processed_at;
  `.trim();

  await runWrangler([
    "d1",
    "execute",
    D1_DATABASE_NAME,
    "--command",
    metadataSql,
  ]);

  console.log(`\n✅ Uploaded:`);
  console.log(`   D1 row: newsletters(${date})`);
  console.log(`\n🌐 View at: https://levine.yet-to-be.com/newsletter/${date}`);
}

function createScriptEnv(perplexityApiKey: string): Env {
  return {
    DB: undefined as never,
    PERPLEXITY_API_KEY: perplexityApiKey,
    RESEND_API_KEY: "",
    SITE_URL: "http://localhost:8787",
    EMAIL_DOMAIN: "",
    FETCHER: {
      fetch(input: RequestInfo | URL, init?: RequestInit) {
        const target = new URL(
          typeof input === "string" ? input : input.toString(),
        );
        const url = new URL(
          `${target.pathname}${target.search}${target.hash}`,
          FETCHER_BASE_URL,
        );
        return fetch(url, init);
      },
    } as Env["FETCHER"],
  };
}

async function runWrangler(args: string[]) {
  const proc = Bun.spawn(["bunx", "wrangler", ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`wrangler ${args.join(" ")} failed with exit code ${exitCode}`);
  }
}

function toSqlString(value: string | undefined): string {
  if (value == null) return "NULL";
  return `'${value.replace(/'/g, "''")}'`;
}

main().catch(console.error);


