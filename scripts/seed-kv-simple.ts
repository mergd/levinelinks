import PostalMime from "postal-mime";
import { stripForwardedHeaders } from "../src/services/parser";

const EML_PATH = process.argv[2] || "./Money Stuff: Take the Crypto Out of the Indexes.eml";

async function main() {
  console.log("📧 Parsing email...");
  const file = Bun.file(EML_PATH);
  const raw = await file.text();

  const parser = new PostalMime();
  const parsed = await parser.parse(raw);

  const rawHtml = parsed.html || parsed.text || "";
  const html = stripForwardedHeaders(rawHtml);
  const subject = (parsed.subject || "Money Stuff").replace(/^(Fwd?:\s*)+/gi, "").trim();

  // Extract date from newsletter URL or use email date
  const urlDateMatch = rawHtml.match(/\/(\d{4}-\d{2}-\d{2})\//);
  const date = urlDateMatch?.[1] || (parsed.date ? new Date(parsed.date).toISOString().split("T")[0] : new Date().toISOString().split("T")[0]);

  console.log(`   Subject: ${subject}`);
  console.log(`   Date: ${date}`);

  // Extract preview text - strip style/script tags first
  const textContent = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const preview = textContent.slice(0, 200).trim();

  const metadata = {
    date,
    subject,
    preview,
    processedAt: new Date().toISOString(),
  };

  console.log("\n☁️  Uploading to Cloudflare KV (without AI enrichment)...");

  const htmlKey = `${date}.html`;
  const jsonKey = `${date}.json`;
  const kvNamespaceId = "12fe9a29ec85487aa5d9eaeac7a8730c";

  // Write temp files
  await Bun.write(`/tmp/${htmlKey}`, html);
  await Bun.write(`/tmp/${jsonKey}`, JSON.stringify(metadata));

  const proc1 = Bun.spawn(["bunx", "wrangler", "kv", "key", "put", htmlKey, "--path", `/tmp/${htmlKey}`, "--namespace-id", kvNamespaceId, "--remote"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc1.exited;

  const proc2 = Bun.spawn(["bunx", "wrangler", "kv", "key", "put", jsonKey, "--path", `/tmp/${jsonKey}`, "--namespace-id", kvNamespaceId, "--remote"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc2.exited;

  console.log(`\n✅ Uploaded:`);
  console.log(`   ${htmlKey}`);
  console.log(`   ${jsonKey}`);
  console.log(`\n🌐 View at: https://levine.yet-to-be.com/newsletter/${date}`);
  console.log(`   Archive: https://levine.yet-to-be.com/`);
}

main().catch(console.error);

