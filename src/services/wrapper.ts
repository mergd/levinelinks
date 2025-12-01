import { resolveTrackingUrl } from "./parser";
import { getPerplexitySummary } from "./enricher";

interface EnrichedLinkData {
  originalUrl: string;
  resolvedUrl: string;
  summary?: string;
  archiveUrl?: string;
  favicon?: string;
}

const SKIP_DOMAINS = [
  "twitter.com",
  "x.com",
  "youtube.com",
  "youtu.be",
  "bloomberg.com/account",
  "bloomberg.com/email-settings",
  "bloomberg.com/help",
  "bloomberg.com/subscriptions",
  "bloomberg.com/privacy",
  "bloomberg.com/tos",
  "bloombergmedia.com",
  "unsubscribe",
  "bloom.bg",
  "mail.bloombergbusiness.com",
  "link.mail.bloombergbusiness.com",
  "liveintent.com",
  "assets.bwbx.io",
  "spmailtechnolo.com",
];

// Skip generic/short URLs that are likely navigation, not articles
const SKIP_EXACT_URLS = [
  "http://bloomberg.com/",
  "https://bloomberg.com/",
  "http://www.bloomberg.com/",
  "https://www.bloomberg.com/",
];

const SKIP_URL_PATTERNS = [
  /bloomberg\.com\/.*\/newsletters\/\d{4}-\d{2}-\d{2}/,
];

const SKIP_PATTERNS = [/^mailto:/, /^#/, /\.(jpg|jpeg|png|gif|webp|svg|pdf)$/i];

// Only call Perplexity/archive.is for these paywalled sites
const PAYWALLED_DOMAINS = [
  "wsj.com",
  "nytimes.com",
  "ft.com",
  "economist.com",
  "washingtonpost.com",
  "bloomberg.com",
  "barrons.com",
  "theatlantic.com",
  "newyorker.com",
  "hbr.org",
  "businessinsider.com",
  "reuters.com",
  "theinformation.com",
  "stratechery.com",
];

function isPaywalledUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return PAYWALLED_DOMAINS.some((d) => hostname.includes(d));
  } catch {
    return false;
  }
}

function shouldSkipUrl(url: string): boolean {
  if (SKIP_PATTERNS.some((p) => p.test(url))) return true;
  if (SKIP_URL_PATTERNS.some((p) => p.test(url))) return true;
  if (SKIP_EXACT_URLS.includes(url.toLowerCase())) return true;

  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const fullUrl = url.toLowerCase();
    return SKIP_DOMAINS.some(
      (d) => hostname.includes(d) || fullUrl.includes(d)
    );
  } catch {
    return true;
  }
}

// Cache favicons by domain to avoid duplicate entries
const faviconCache = new Map<string, string>();

function getFaviconUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const domain = parsed.hostname;

    if (faviconCache.has(domain)) {
      return faviconCache.get(domain)!;
    }

    const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
    faviconCache.set(domain, faviconUrl);
    return faviconUrl;
  } catch {
    return "";
  }
}

async function fetchOgImage(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; LevineLinks/1.0)" },
      redirect: "follow",
    });
    if (!response.ok) return undefined;

    const html = await response.text();

    // Look for og:image
    const ogMatch =
      html.match(
        /<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i
      ) ||
      html.match(
        /<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i
      );

    if (ogMatch?.[1]) {
      return ogMatch[1];
    }

    // Fallback to twitter:image
    const twMatch =
      html.match(
        /<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i
      ) ||
      html.match(
        /<meta[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:image["']/i
      );

    return twMatch?.[1];
  } catch {
    return undefined;
  }
}

async function getDirectArchiveUrl(url: string): Promise<string | undefined> {
  try {
    // Use archive.today which often works better
    const searchUrl = `https://archive.today/newest/${encodeURIComponent(url)}`;
    const response = await fetch(searchUrl, {
      method: "HEAD",
      redirect: "manual",
    });

    // Check for redirect to actual archive
    const location = response.headers.get("location");
    if (location && /archive\.(is|today|ph|md)\/\w+/.test(location)) {
      console.log(`    📄 Found archive: ${location}`);
      return location;
    }

    // If 200, the page itself might be the archive
    if (response.status === 200) {
      const finalUrl = response.url;
      if (
        /archive\.(is|today|ph|md)\/\w+/.test(finalUrl) &&
        !finalUrl.includes("/newest/")
      ) {
        console.log(`    📄 Found archive: ${finalUrl}`);
        return finalUrl;
      }
    }

    return undefined;
  } catch (e) {
    console.log(`    ✗ Archive error: ${e}`);
    return undefined;
  }
}

function stripCitations(text: string): string {
  return text
    .replace(/\[\d+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function fixMojibake(text: string): string {
  // Fix common UTF-8 mojibake patterns (UTF-8 decoded as Windows-1252)
  return text
    .replace(/â€œ/g, '"') // Left double quote
    .replace(/â€/g, '"') // Right double quote
    .replace(/â€™/g, "'") // Right single quote / apostrophe
    .replace(/â€˜/g, "'") // Left single quote
    .replace(/â€"/g, "—") // Em dash
    .replace(/â€"/g, "–") // En dash
    .replace(/â€¦/g, "…") // Ellipsis
    .replace(/Â /g, " ") // Non-breaking space
    .replace(/Â/g, ""); // Stray Â
}

function stripForwardingWrapper(html: string): string {
  // Remove "Begin forwarded message" block (Apple Mail)
  let cleaned = html.replace(
    />\s*Begin forwarded message:\s*<\/\w+>[\s\S]*?<blockquote[^>]*>/i,
    ">"
  );

  // Remove forwarded message header table (Apple Mail)
  cleaned = cleaned.replace(
    /<blockquote[^>]*>[\s\S]*?<b>From:<\/b>[\s\S]*?<b>To:<\/b>[\s\S]*?<\/blockquote>/gi,
    ""
  );

  // Gmail style: "---------- Forwarded message ---------"
  cleaned = cleaned.replace(
    /-{5,}\s*Forwarded message\s*-{5,}[\s\S]*?(?=<table|<div[^>]*class)/i,
    ""
  );

  // Remove common forwarding headers
  cleaned = cleaned.replace(
    /<div[^>]*>[\s\S]*?<b>From:<\/b>[^<]*Matt Levine[\s\S]*?<b>Subject:<\/b>[\s\S]*?<\/div>/gi,
    ""
  );

  return cleaned;
}

export interface WrapResult {
  html: string;
  preview: string;
  ogImage?: string;
}

export async function wrapNewsletter(
  html: string,
  perplexityApiKey: string,
  limit: number = 50
): Promise<WrapResult> {
  // Strip forwarding wrappers (Apple Mail, Gmail, etc.)
  let processedHtml = stripForwardingWrapper(html);

  // Fix mojibake (UTF-8 displayed as Windows-1252)
  processedHtml = fixMojibake(processedHtml);

  // Strip Apple Mail specific styles
  processedHtml = processedHtml
    .replace(/background-color:\s*rgb\(204,\s*204,\s*204\);?/gi, "")
    .replace(/x-msg:\/\/\d+\//gi, "")
    .replace(/<span class="Apple-converted-space">[^<]*<\/span>/gi, " ");

  // Remove podcast image
  processedHtml = processedHtml.replace(
    /<img[^>]*alt=["']Listen to the money stuff podcast["'][^>]*>/gi,
    ""
  );

  // Remove Bloomberg footer (unsubscribe, contact, etc.) - be conservative
  processedHtml = processedHtml
    .replace(
      /You received this message because you are subscribed to Bloomberg[^<]*<\/\w+>/gi,
      ""
    )
    .replace(/Ads Powered By Liveintent[^<]*Ad Choices/gi, "")
    .replace(/Bloomberg L\.P\.\s*731 Lexington[^<]*10022/gi, "")
    .replace(/<a[^>]*>Unsubscribe<\/a>/gi, "")
    .replace(/<a[^>]*>Contact Us<\/a>/gi, "");

  const linkRegex = /<a\s+([^>]*href=["']([^"']+)["'][^>]*)>([\s\S]*?)<\/a>/gi;
  const linksToProcess: Array<{
    match: string;
    url: string;
    text: string;
    fullMatch: string;
  }> = [];

  let match;
  while ((match = linkRegex.exec(processedHtml)) !== null) {
    const url = match[2];
    const text = match[3].replace(/<[^>]+>/g, "").trim();

    // Skip links without URLs or text, but keep processing them for URL resolution
    if (!url) continue;
    if (shouldSkipUrl(url)) continue;

    linksToProcess.push({
      match: match[0],
      url,
      text: text || "",
      fullMatch: match[0],
    });
  }

  const uniqueUrls = [...new Set(linksToProcess.map((l) => l.url))];
  const enrichedData = new Map<string, EnrichedLinkData>();

  // Step 1: Resolve ALL tracking URLs and add favicons (cheap operations)
  console.log(`Resolving ${uniqueUrls.length} URLs...`);
  for (const originalUrl of uniqueUrls) {
    const resolvedUrl = await resolveTrackingUrl(originalUrl);
    const favicon = getFaviconUrl(resolvedUrl);

    enrichedData.set(originalUrl, {
      originalUrl,
      resolvedUrl,
      favicon,
    });
  }
  console.log(`  ✓ Resolved all URLs`);

  // Step 2: Summarize only up to `limit` links (expensive Perplexity API calls)
  // Only summarize links with meaningful text (article links, not logos/icons)
  // Process from END of newsletter first (most important links are at the end)
  const urlsToSummarize = uniqueUrls
    .filter((url) => {
      const data = enrichedData.get(url);
      const link = linksToProcess.find((l) => l.url === url);
      const hasText = link && link.text && link.text.length >= 3;
      return data && !shouldSkipUrl(data.resolvedUrl) && hasText;
    })
    .reverse() // Start from end of newsletter
    .slice(0, limit);

  console.log(
    `Summarizing ${urlsToSummarize.length}/${uniqueUrls.length} links (limit: ${limit})...`
  );

  let summarized = 0;
  for (const originalUrl of urlsToSummarize) {
    const data = enrichedData.get(originalUrl);
    if (!data) continue;

    summarized++;
    const isPaywalled = isPaywalledUrl(data.resolvedUrl);
    console.log(
      `  [${summarized}/${urlsToSummarize.length}] ${data.resolvedUrl.slice(0, 55)}... ${isPaywalled ? "💰" : ""}`
    );

    let summary: string | undefined;
    let archiveUrl: string | undefined;

    try {
      // Only call expensive APIs for paywalled sites
      if (isPaywalled) {
        [summary, archiveUrl] = await Promise.all([
          getPerplexitySummary(data.resolvedUrl, "", perplexityApiKey),
          getDirectArchiveUrl(data.resolvedUrl),
        ]);
      }
    } catch (e) {
      console.log(`    ✗ Error: ${e}`);
    }

    const cleanSummary = summary ? stripCitations(summary) : undefined;

    // Update with summary and archive
    enrichedData.set(originalUrl, {
      ...data,
      summary: cleanSummary,
      archiveUrl,
    });

    if (cleanSummary) {
      const snippet = cleanSummary.slice(0, 60).replace(/\n/g, " ");
      console.log(`    ✓ "${snippet}..."`);
    } else if (isPaywalled) {
      console.log(`    ○ no summary`);
    }
    if (archiveUrl) console.log(`    📄 ${archiveUrl}`);
  }

  for (const link of linksToProcess) {
    const data = enrichedData.get(link.url);
    if (!data) continue;

    const newLinkHtml = generateEnrichedLink(link.fullMatch, link.text, data);
    processedHtml = processedHtml.replace(link.fullMatch, newLinkHtml);
  }

  // Replace "View in browser" link with our preview link
  processedHtml = processedHtml.replace(
    />View in browser<\/a>/gi,
    ">View enhanced version</a>"
  );

  // Process footnotes - make them inline expandable
  processedHtml = processFootnotes(processedHtml);

  // Extract preview text
  const textContent = processedHtml
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const preview = textContent.slice(0, 200).trim();

  // Try to get OG image from first article link
  let ogImage: string | undefined;
  const articleUrls = [...enrichedData.values()]
    .filter(
      (d) =>
        d.resolvedUrl &&
        !d.resolvedUrl.includes("bloomberg.com/opinion/newsletters")
    )
    .map((d) => d.resolvedUrl);

  for (const url of articleUrls.slice(0, 3)) {
    ogImage = await fetchOgImage(url);
    if (ogImage) {
      console.log(`📸 Found OG image from ${url}`);
      break;
    }
  }

  return { html: processedHtml, preview, ogImage };
}

function processFootnotes(html: string): string {
  // Extract footnote definitions: <div id="footnote-X">...<p>content</p>...</div>
  const footnoteContents = new Map<string, string>();
  const footnoteDefRegex =
    /<div\s+id="footnote-(\d+)"[^>]*>[\s\S]*?<p[^>]*>\[?\d+\]?\s*([\s\S]*?)<\/p>[\s\S]*?<\/div>/gi;
  let match;
  while ((match = footnoteDefRegex.exec(html)) !== null) {
    const num = match[1];
    const content = match[2]
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    footnoteContents.set(num, content);
  }

  let result = html;
  for (const [num, content] of footnoteContents) {
    const refPattern = new RegExp(
      `<a\\s+href="#footnote-${num}"[^>]*>\\s*<span>\\[${num}\\]</span>\\s*</a>`,
      "gi"
    );
    // Single click shows full footnote inline
    const replacement = `<sup><details style="display:inline-block;vertical-align:baseline;margin:0;padding:0;"><summary style="cursor:pointer;color:#1976d2;list-style:none;display:inline;font-size:11px;margin:0;padding:0;">[${num}]</summary><span style="font-size:12px;color:#555;background:#f5f5f5;padding:2px 6px;border-radius:3px;margin-left:2px;">${escapeHtml(content)}</span></details></sup>`;
    result = result.replace(refPattern, replacement);
  }

  // Remove footnote definitions at bottom
  result = result.replace(
    /<div\s+id="footnote-\d+"[^>]*>[\s\S]*?<\/div>/gi,
    ""
  );
  return result;
}

export function addPreviewHeader(html: string, previewUrl: string): string {
  // Add a header banner for the enhanced version
  const banner = `<div style="background:#1976d2;color:#fff;padding:12px 16px;font-family:sans-serif;font-size:14px;text-align:center;">
    <strong>🔗 Levine Links Enhanced</strong> — Summaries and archive links added. 
    <a href="${previewUrl}" style="color:#fff;text-decoration:underline;">View web version</a>
  </div>`;

  // Insert after <body> tag
  return html.replace(/<body([^>]*)>/i, `<body$1>${banner}`);
}

function generateEnrichedLink(
  originalLinkHtml: string,
  linkText: string,
  data: EnrichedLinkData
): string {
  const hasText = linkText && linkText.length >= 3;

  // Favicon before link text
  const faviconHtml =
    data.favicon && hasText
      ? `<img src="${data.favicon}" style="width:20px;height:20px;vertical-align:middle;margin-right:6px;border:0;" alt="">`
      : "";

  // Replace href with resolved URL and add target="_blank"
  let updatedLink = originalLinkHtml
    .replace(/href=(["'])([^"']+)\1/, `href=$1${data.resolvedUrl}$1`)
    .replace(/target=["'][^"']*["']/gi, "") // Remove existing target
    .replace(/<a\s+/, '<a target="_blank" rel="noopener" '); // Add at start of <a>

  // Add favicon before link text
  if (hasText && faviconHtml) {
    const linkTextEscaped = linkText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    updatedLink = updatedLink.replace(
      new RegExp(`>\\s*(${linkTextEscaped})`),
      `>${faviconHtml}$1`
    );
  }

  let result = updatedLink;

  // Add summary inline (no block elements, no newlines)
  if (data.summary && hasText) {
    const fullText = data.summary.replace(/\s+/g, " ").trim();
    const sentences = fullText.match(/[^.!?]+[.!?]+/g) || [fullText];
    const preview = sentences.slice(0, 2).join(" ").trim();
    const hasMore = sentences.length > 2;
    const restText = sentences.slice(2).join(" ").trim();

    // Archive + summary icon inline with spacing
    const archiveLink = data.archiveUrl
      ? `<a href="${data.archiveUrl}" target="_blank" rel="noopener" style="text-decoration:none;font-size:13px;vertical-align:middle;margin-right:4px;" title="Read archived (no paywall)">📰</a>`
      : "";

    // Build inline expansion - all on same line
    result += `${archiveLink}<details style="display:inline-block;vertical-align:baseline;margin:0;padding:0;"><summary style="cursor:pointer;list-style:none;display:inline;margin:0;padding:0;">💡</summary><span style="font-size:13px;color:#444;margin-left:4px;">${escapeHtml(preview)}`;
    if (hasMore) {
      result += ` <details style="display:inline;margin:0;padding:0;"><summary style="cursor:pointer;color:#1976d2;font-size:11px;list-style:none;display:inline;margin:0;padding:0;">[more]</summary><span>${escapeHtml(restText)}</span></details>`;
    }
    result += ` <a href="${data.resolvedUrl}" target="_blank" rel="noopener" style="color:#1976d2;font-size:11px;text-decoration:none;">[read]</a>`;
    if (data.archiveUrl) {
      result += ` <a href="${data.archiveUrl}" target="_blank" rel="noopener" style="color:#2e7d32;font-size:11px;text-decoration:none;">[archive]</a>`;
    }
    result += `</span></details>`;
  } else if (data.archiveUrl && hasText) {
    // No summary but has archive
    result += ` <a href="${data.archiveUrl}" target="_blank" rel="noopener" style="text-decoration:none;font-size:13px;" title="Read archived (no paywall)">📰</a>`;
  }

  return result;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
