import { stripForwardedHeaders } from "../src/services/parser";
import { R2_NEWSLETTER_BUCKET } from "./r2-config";

const DATE = process.argv[2] || "2025-12-04";

async function main() {
  console.log(`🔧 Fixing newsletter ${DATE}...`);

  console.log("📥 Downloading current HTML from R2...");
  const downloadProc = Bun.spawn(
    [
      "bunx",
      "wrangler",
      "r2",
      "object",
      "get",
      `${R2_NEWSLETTER_BUCKET}/${DATE}.html`,
      "--remote",
      "-p",
    ],
    { stdout: "pipe", stderr: "pipe" }
  );

  const output = await new Response(downloadProc.stdout).text();
  await downloadProc.exited;

  if (
    downloadProc.exitCode !== 0 ||
    !output ||
    output.length < 100
  ) {
    console.error("❌ Failed to download HTML or value not found");
    process.exit(1);
  }

  console.log(`📏 Downloaded ${output.length} bytes`);

  console.log("🧹 Stripping forwarding wrappers...");
  let fixedHtml = output;

  if (fixedHtml.includes("gmail_quote") || fixedHtml.includes("gmail_attr")) {
    console.log("📧 Detected Gmail forwarding structure...");

    const newsletterStart = fixedHtml.match(
      /<div[^>]*style="[^"]*width:\s*100%[^"]*font-family:[^"]*Helvetica[^"]*"[^>]*>([\s\S]*)/i
    );

    if (newsletterStart) {
      fixedHtml = `<div style="width:100%;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:150%;margin:0;padding:0">${newsletterStart[1]}`;
      fixedHtml = fixedHtml.replace(/<\/div>\s*<\/div>\s*<\/div>\s*$/gi, "</div>");
    } else {
      const wrapperMatch = fixedHtml.match(
        /<table[^>]*id="[^"]*wrapper[^"]*"[^>]*>[\s\S]*/i
      );
      if (wrapperMatch) {
        fixedHtml = wrapperMatch[0];
      }
    }
  }

  fixedHtml = stripForwardedHeaders(fixedHtml);

  fixedHtml = fixedHtml
    .replace(/^(\s|<br\s*\/?>|<div[^>]*>\s*<\/div>)+/gi, "")
    .replace(/(\s|<br\s*\/?>|<div[^>]*>\s*<\/div>)+$/gi, "")
    .trim();

  console.log(`📏 Fixed HTML: ${fixedHtml.length} bytes`);

  await Bun.write(`/tmp/${DATE}-fixed.html`, fixedHtml);
  console.log(`💾 Saved to /tmp/${DATE}-fixed.html for review`);

  console.log("\n📝 Preview:");
  console.log(fixedHtml.slice(0, 500));
  console.log("...\n");

  console.log("☁️  Uploading fixed HTML to R2...");
  await Bun.write(`/tmp/${DATE}.html`, fixedHtml);
  const uploadProc = Bun.spawn(
    [
      "bunx",
      "wrangler",
      "r2",
      "object",
      "put",
      `${R2_NEWSLETTER_BUCKET}/${DATE}.html`,
      "--file",
      `/tmp/${DATE}.html`,
      "--remote",
      "--content-type",
      "text/html; charset=utf-8",
    ],
    { stdout: "inherit", stderr: "inherit" }
  );
  await uploadProc.exited;

  if (uploadProc.exitCode !== 0) {
    process.exit(uploadProc.exitCode ?? 1);
  }

  console.log(
    `\n✅ Fixed! View at: https://levine.yet-to-be.com/newsletter/${DATE}`
  );
}

main().catch(console.error);
