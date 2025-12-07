import PostalMime from "postal-mime";
import { extractLinksFromHtml, isPaywalledUrl, resolveTrackingUrl } from "../src/services/parser";
import { getPerplexitySummary, getArchiveUrl } from "../src/services/enricher";
import type { EnrichedLink } from "../src/types";

const EML_PATH = "./Money Stuff: Take the Crypto Out of the Indexes.eml";
const OUTPUT_PATH = "./preview.html";

async function main() {
  const perplexityKey = process.env.PERPLEXITY_API_KEY;
  if (!perplexityKey) {
    console.error("Missing PERPLEXITY_API_KEY in .env");
    process.exit(1);
  }

  console.log("📧 Parsing email...");
  const file = Bun.file(EML_PATH);
  const raw = await file.text();

  const parser = new PostalMime();
  const parsed = await parser.parse(raw);

  const subject = parsed.subject || "Money Stuff";
  const date = parsed.date ? new Date(parsed.date).toISOString().split("T")[0] : "unknown";

  console.log(`   Subject: ${subject}`);
  console.log(`   Date: ${date}`);

  const html = parsed.html || parsed.text || "";
  const rawLinks = extractLinksFromHtml(html);

  console.log(`\n🔗 Found ${rawLinks.length} raw links, deduping...`);

  const uniqueLinks = new Map<string, (typeof rawLinks)[0]>();
  for (const link of rawLinks) {
    if (!uniqueLinks.has(link.url)) {
      uniqueLinks.set(link.url, link);
    }
  }

  console.log(`   ${uniqueLinks.size} unique links`);

  console.log("\n🔄 Resolving tracking URLs...");
  const enrichedLinks: EnrichedLink[] = [];

  for (const [originalUrl, link] of uniqueLinks) {
    const resolvedUrl = await resolveTrackingUrl(originalUrl);
    const isPaywalled = isPaywalledUrl(resolvedUrl);

    enrichedLinks.push({
      ...link,
      url: resolvedUrl,
      isPaywalled,
    });
  }

  const paywalledLinks = enrichedLinks.filter((l) => l.isPaywalled);
  console.log(`   ${paywalledLinks.length} paywalled articles found`);

  console.log("\n🤖 Getting Perplexity summaries for paywalled articles...");
  for (const link of paywalledLinks) {
    console.log(`   → ${link.text.slice(0, 50)}...`);
    
    const [summary, archiveUrl] = await Promise.all([
      getPerplexitySummary(link.url, link.text, perplexityKey),
      getArchiveUrl(link.url),
    ]);

    link.summary = summary;
    link.archiveUrl = archiveUrl;

    if (summary) {
      console.log(`     ✓ Got summary (${summary.length} chars)`);
    } else {
      console.log(`     ✗ No summary available`);
    }

    if (archiveUrl) {
      console.log(`     ✓ Archive found`);
    }
  }

  console.log("\n📝 Generating preview HTML...");
  const previewHtml = generatePreviewHtml(subject, date, enrichedLinks);
  await Bun.write(OUTPUT_PATH, previewHtml);

  console.log(`\n✅ Done! Open ${OUTPUT_PATH} in your browser to preview.`);
  console.log(`   Or run: open ${OUTPUT_PATH}`);
}

function generatePreviewHtml(subject: string, date: string, links: EnrichedLink[]): string {
  const linkSections = links
    .map((link) => {
      if (link.isPaywalled) {
        return `
        <article class="link paywalled">
          <div class="link-header">
            <a href="${link.archiveUrl || link.url}" target="_blank" rel="noopener">${escapeHtml(link.text)}</a>
            <span class="badge">Paywalled</span>
            ${link.archiveUrl ? `<a href="${link.archiveUrl}" class="archive-link" target="_blank" rel="noopener">📦 Archive</a>` : '<span class="no-archive">No archive</span>'}
          </div>
          ${link.summary ? `<p class="summary">${escapeHtml(link.summary)}</p>` : '<p class="no-summary">No summary available</p>'}
          <div class="original-url">${escapeHtml(link.url)}</div>
        </article>`;
      }
      return `
        <article class="link">
          <a href="${link.url}" target="_blank" rel="noopener">${escapeHtml(link.text)}</a>
          <div class="original-url">${escapeHtml(link.url)}</div>
        </article>`;
    })
    .join("");

  const paywalledCount = links.filter((l) => l.isPaywalled).length;
  const withSummary = links.filter((l) => l.summary).length;
  const withArchive = links.filter((l) => l.archiveUrl).length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Preview: ${escapeHtml(subject)}</title>
  <style>
    :root {
      --bg: #0d1117;
      --surface: #161b22;
      --surface-hover: #1c2128;
      --text: #c9d1d9;
      --text-muted: #8b949e;
      --accent: #58a6ff;
      --warning: #f85149;
      --success: #3fb950;
      --border: #30363d;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'SF Pro Text', -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      padding: 2rem 1rem;
    }
    .container { max-width: 800px; margin: 0 auto; }
    header {
      border-bottom: 1px solid var(--border);
      padding-bottom: 1.5rem;
      margin-bottom: 2rem;
    }
    h1 {
      font-size: 1.75rem;
      font-weight: 600;
      background: linear-gradient(135deg, var(--accent), #a371f7);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .meta { color: var(--text-muted); margin-top: 0.5rem; font-size: 0.9rem; }
    .stats {
      display: flex;
      gap: 1.5rem;
      margin-top: 1rem;
      font-size: 0.85rem;
    }
    .stat { color: var(--text-muted); }
    .stat strong { color: var(--text); }
    
    .link {
      background: var(--surface);
      border-radius: 8px;
      padding: 1rem 1.25rem;
      margin: 0.75rem 0;
      transition: background 0.15s;
    }
    .link:hover { background: var(--surface-hover); }
    .link > a {
      color: var(--accent);
      text-decoration: none;
      font-weight: 500;
      font-size: 1rem;
    }
    .link > a:hover { text-decoration: underline; }
    .link.paywalled { border-left: 3px solid var(--warning); }
    
    .link-header {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.5rem;
    }
    .link-header a:first-child {
      color: var(--accent);
      text-decoration: none;
      font-weight: 500;
    }
    .badge {
      display: inline-block;
      background: var(--warning);
      color: #fff;
      font-size: 0.7rem;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 500;
    }
    .archive-link {
      color: var(--success) !important;
      font-size: 0.8rem;
      text-decoration: none !important;
    }
    .archive-link:hover { text-decoration: underline !important; }
    .no-archive {
      color: var(--text-muted);
      font-size: 0.75rem;
    }
    .summary {
      color: var(--text);
      font-size: 0.9rem;
      margin-top: 0.75rem;
      padding-top: 0.75rem;
      border-top: 1px solid var(--border);
      line-height: 1.7;
    }
    .no-summary {
      color: var(--text-muted);
      font-size: 0.8rem;
      font-style: italic;
      margin-top: 0.5rem;
    }
    .original-url {
      color: var(--text-muted);
      font-size: 0.7rem;
      margin-top: 0.5rem;
      word-break: break-all;
      opacity: 0.7;
    }
    
    h2 {
      font-size: 1.1rem;
      color: var(--text-muted);
      margin: 2rem 0 1rem;
      padding-bottom: 0.5rem;
      border-bottom: 1px solid var(--border);
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Levine Links Preview</h1>
      <p class="meta">${escapeHtml(subject)} • ${date}</p>
      <div class="stats">
        <span class="stat"><strong>${links.length}</strong> total links</span>
        <span class="stat"><strong>${paywalledCount}</strong> paywalled</span>
        <span class="stat"><strong>${withSummary}</strong> with summaries</span>
        <span class="stat"><strong>${withArchive}</strong> with archives</span>
      </div>
    </header>
    
    <main>
      <h2>🔒 Paywalled Articles (${paywalledCount})</h2>
      ${links.filter(l => l.isPaywalled).map(link => `
        <article class="link paywalled">
          <div class="link-header">
            <a href="${link.archiveUrl || link.url}" target="_blank" rel="noopener">${escapeHtml(link.text)}</a>
            <span class="badge">Paywalled</span>
            ${link.archiveUrl ? `<a href="${link.archiveUrl}" class="archive-link" target="_blank" rel="noopener">📦 Archive</a>` : '<span class="no-archive">No archive</span>'}
          </div>
          ${link.summary ? `<p class="summary">${escapeHtml(link.summary)}</p>` : '<p class="no-summary">No summary available</p>'}
          <div class="original-url">${escapeHtml(link.url)}</div>
        </article>
      `).join("")}
      
      <h2>✓ Open Articles (${links.length - paywalledCount})</h2>
      ${links.filter(l => !l.isPaywalled).map(link => `
        <article class="link">
          <a href="${link.url}" target="_blank" rel="noopener">${escapeHtml(link.text)}</a>
          <div class="original-url">${escapeHtml(link.url)}</div>
        </article>
      `).join("")}
    </main>
  </div>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

main().catch(console.error);







