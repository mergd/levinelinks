import { stripForwardedHeaders } from "../src/services/parser";

const DATE = process.argv[2] || "2025-12-04";
const KV_NAMESPACE_ID = "12fe9a29ec85487aa5d9eaeac7a8730c";

async function main() {
  console.log(`🔧 Fixing newsletter ${DATE}...`);

  // Download current HTML (use --remote to access production KV)
  console.log("📥 Downloading current HTML from KV...");
  const downloadProc = Bun.spawn([
    "bunx", "wrangler", "kv", "key", "get", `${DATE}.html`,
    "--namespace-id", KV_NAMESPACE_ID, "--remote"
  ], { stdout: "pipe" });
  
  const output = await new Response(downloadProc.stdout).text();
  await downloadProc.exited;
  
  if (!output || output.length < 100 || output.includes("Value not found")) {
    console.error("❌ Failed to download HTML or value not found");
    process.exit(1);
  }
  
  console.log(`📏 Downloaded ${output.length} bytes`);

  // Strip Gmail wrapper
  console.log("🧹 Stripping forwarding wrappers...");
  let fixedHtml = output;
  
  // Gmail class-based forwarding: extract content from gmail_quote wrapper
  if (fixedHtml.includes('gmail_quote') || fixedHtml.includes('gmail_attr')) {
    console.log("📧 Detected Gmail forwarding structure...");
    
    // Find the inner newsletter content (the actual Bloomberg email HTML)
    // Look for the Bloomberg table structure that starts the actual newsletter
    const newsletterStart = fixedHtml.match(
      /<div[^>]*style="[^"]*width:\s*100%[^"]*font-family:[^"]*Helvetica[^"]*"[^>]*>([\s\S]*)/i
    );
    
    if (newsletterStart) {
      fixedHtml = `<div style="width:100%;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:150%;margin:0;padding:0">${newsletterStart[1]}`;
      // Clean up trailing Gmail divs
      fixedHtml = fixedHtml.replace(/<\/div>\s*<\/div>\s*<\/div>\s*$/gi, "</div>");
    } else {
      // Fallback: try to find the table with id="wrapper"
      const wrapperMatch = fixedHtml.match(/<table[^>]*id="[^"]*wrapper[^"]*"[^>]*>[\s\S]*/i);
      if (wrapperMatch) {
        fixedHtml = wrapperMatch[0];
      }
    }
  }
  
  // Apply the parser's strip function as additional cleanup
  fixedHtml = stripForwardedHeaders(fixedHtml);
  
  // Remove leading/trailing whitespace and empty tags
  fixedHtml = fixedHtml
    .replace(/^(\s|<br\s*\/?>|<div[^>]*>\s*<\/div>)+/gi, "")
    .replace(/(\s|<br\s*\/?>|<div[^>]*>\s*<\/div>)+$/gi, "")
    .trim();

  console.log(`📏 Fixed HTML: ${fixedHtml.length} bytes`);
  
  // Save locally for review
  await Bun.write(`/tmp/${DATE}-fixed.html`, fixedHtml);
  console.log(`💾 Saved to /tmp/${DATE}-fixed.html for review`);

  // Preview first 500 chars
  console.log("\n📝 Preview:");
  console.log(fixedHtml.slice(0, 500));
  console.log("...\n");

  // Upload fixed HTML
  console.log("☁️  Uploading fixed HTML to KV...");
  await Bun.write(`/tmp/${DATE}.html`, fixedHtml);
  const uploadProc = Bun.spawn([
    "bunx", "wrangler", "kv", "key", "put", `${DATE}.html`,
    "--path", `/tmp/${DATE}.html`,
    "--namespace-id", KV_NAMESPACE_ID,
    "--remote"
  ]);
  await uploadProc.exited;
  
  console.log(`\n✅ Fixed! View at: https://levine.yet-to-be.com/newsletter/${DATE}`);
}

main().catch(console.error);

