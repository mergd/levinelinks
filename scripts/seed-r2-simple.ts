import PostalMime from "postal-mime";
import { stripForwardedHeaders } from "../src/services/parser";
import { R2_NEWSLETTER_BUCKET } from "./r2-config";
import { ISSUES_INDEX_KEY } from "../src/services/newsletter-storage";

const EML_PATH =
  process.argv[2] || "./Money Stuff: Take the Crypto Out of the Indexes.eml";

async function main() {
  console.log("📧 Parsing email...");
  const file = Bun.file(EML_PATH);
  const raw = await file.text();

  const parser = new PostalMime();
  const parsed = await parser.parse(raw);

  const rawHtml = parsed.html || parsed.text || "";
  const html = stripForwardedHeaders(rawHtml);
  const subject = (parsed.subject || "Money Stuff")
    .replace(/^(Fwd?:\s*)+/gi, "")
    .trim();

  const urlDateMatch = rawHtml.match(/\/(\d{4}-\d{2}-\d{2})\//);
  const date =
    urlDateMatch?.[1] ||
    (parsed.date
      ? new Date(parsed.date).toISOString().split("T")[0]
      : new Date().toISOString().split("T")[0]);

  console.log(`   Subject: ${subject}`);
  console.log(`   Date: ${date}`);

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

  console.log("\n☁️  Uploading to R2...");

  const htmlKey = `${date}.html`;
  const jsonKey = `${date}.json`;

  await Bun.write(`/tmp/${htmlKey}`, html);
  await Bun.write(`/tmp/${jsonKey}`, JSON.stringify(metadata));

  const put = (
    objectPath: string,
    filePath: string,
    contentType: string
  ) =>
    Bun.spawn(
      [
        "bunx",
        "wrangler",
        "r2",
        "object",
        "put",
        objectPath,
        "--file",
        filePath,
        "--remote",
        "--content-type",
        contentType,
      ],
      { stdout: "inherit", stderr: "inherit" }
    );

  let proc = put(
    `${R2_NEWSLETTER_BUCKET}/${htmlKey}`,
    `/tmp/${htmlKey}`,
    "text/html; charset=utf-8"
  );
  await proc.exited;
  if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);

  proc = put(
    `${R2_NEWSLETTER_BUCKET}/${jsonKey}`,
    `/tmp/${jsonKey}`,
    "application/json; charset=utf-8"
  );
  await proc.exited;
  if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);

  const indexGet = Bun.spawn(
    [
      "bunx",
      "wrangler",
      "r2",
      "object",
      "get",
      `${R2_NEWSLETTER_BUCKET}/${ISSUES_INDEX_KEY}`,
      "--remote",
      "-p",
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  const indexText = await new Response(indexGet.stdout).text();
  await indexGet.exited;

  let existingDates: string[] = [];
  if (indexGet.exitCode === 0 && indexText.trim()) {
    try {
      const parsedIndex = JSON.parse(indexText) as { dates?: string[] };
      if (Array.isArray(parsedIndex.dates)) existingDates = parsedIndex.dates;
    } catch {}
  }

  const nextDates = [...new Set([...existingDates, date])].sort((a, b) =>
    b.localeCompare(a)
  );
  await Bun.write(
    `/tmp/${ISSUES_INDEX_KEY}`,
    JSON.stringify({ dates: nextDates })
  );

  proc = put(
    `${R2_NEWSLETTER_BUCKET}/${ISSUES_INDEX_KEY}`,
    `/tmp/${ISSUES_INDEX_KEY}`,
    "application/json; charset=utf-8"
  );
  await proc.exited;
  if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);

  console.log(`\n✅ Uploaded:`);
  console.log(`   ${htmlKey}`);
  console.log(`   ${jsonKey}`);
  console.log(`   ${ISSUES_INDEX_KEY}`);
  console.log(`\n🌐 View at: https://levine.yet-to-be.com/newsletter/${date}`);
}

main().catch(console.error);
