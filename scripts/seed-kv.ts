import PostalMime from "postal-mime";
import { wrapNewsletter } from "../src/services/wrapper";
import { stripForwardedHeaders } from "../src/services/parser";

const EML_PATH =
  process.argv[2] || "./Money Stuff: Take the Crypto Out of the Indexes.eml";

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

  const result = await wrapNewsletter(originalHtml, perplexityKey, 40);

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

  // Now upload to KV
  console.log("\n☁️  Uploading to Cloudflare KV...");

  const htmlKey = `${date}.html`;
  const jsonKey = `${date}.json`;
  const metadata = {
    date,
    subject,
    preview: result.preview,
    ogImage: result.ogImage,
    processedAt: new Date().toISOString(),
  };

  // Use wrangler to upload
  const kvNamespaceId = "12fe9a29ec85487aa5d9eaeac7a8730c";

  // Write temp files
  await Bun.write(`/tmp/${htmlKey}`, result.html);
  await Bun.write(`/tmp/${jsonKey}`, JSON.stringify(metadata));

  const proc1 = Bun.spawn([
    "bunx",
    "wrangler",
    "kv",
    "key",
    "put",
    htmlKey,
    "--path",
    `/tmp/${htmlKey}`,
    "--namespace-id",
    kvNamespaceId,
  ]);
  await proc1.exited;

  const proc2 = Bun.spawn([
    "bunx",
    "wrangler",
    "kv",
    "key",
    "put",
    jsonKey,
    "--path",
    `/tmp/${jsonKey}`,
    "--namespace-id",
    kvNamespaceId,
  ]);
  await proc2.exited;

  console.log(`\n✅ Uploaded:`);
  console.log(`   ${htmlKey}`);
  console.log(`   ${jsonKey}`);
  console.log(`\n🌐 View at: https://levine.yet-to-be.com/newsletter/${date}`);
}

main().catch(console.error);
