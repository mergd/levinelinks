import type {
  Env,
  FetchBatchRequest,
  FetchBatchResponse,
  LinkFetchResult,
} from "../types";

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

function fixMojibake(text: string): string {
  return text
    .replace(/â€œ/g, '"')
    .replace(/â€/g, '"')
    .replace(/â€™/g, "'")
    .replace(/â€˜/g, "'")
    .replace(/â€"/g, "—")
    .replace(/â€"/g, "–")
    .replace(/â€¦/g, "…")
    .replace(/Â /g, " ")
    .replace(/Â/g, "");
}

function stripForwardingWrapper(html: string): string {
  let cleaned = html.replace(
    />\s*Begin forwarded message:\s*<\/\w+>[\s\S]*?<blockquote[^>]*>/i,
    ">"
  );
  cleaned = cleaned.replace(
    /<blockquote[^>]*>[\s\S]*?<b>From:<\/b>[\s\S]*?<b>To:<\/b>[\s\S]*?<\/blockquote>/gi,
    ""
  );
  cleaned = cleaned.replace(
    /-{5,}\s*Forwarded message\s*-{5,}[\s\S]*?(?=<table|<div[^>]*class)/i,
    ""
  );
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

// Split array into N chunks
function chunkArray<T>(arr: T[], numChunks: number): T[][] {
  const chunks: T[][] = [];
  const chunkSize = Math.ceil(arr.length / numChunks);
  for (let i = 0; i < arr.length; i += chunkSize) {
    chunks.push(arr.slice(i, i + chunkSize));
  }
  return chunks;
}

// Call a fetcher worker via service binding
async function callFetcher(
  fetcher: Fetcher,
  items: { url: string; text?: string; fetchOgImage?: boolean }[],
  perplexityApiKey: string
): Promise<LinkFetchResult[]> {
  if (items.length === 0) return [];

  const request: FetchBatchRequest = {
    items,
    perplexityApiKey,
  };

  try {
    const response = await fetcher.fetch("https://internal/_fetch-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      console.error(`Fetcher returned ${response.status}`);
      return [];
    }

    const data = (await response.json()) as FetchBatchResponse;
    return data.results;
  } catch (e) {
    console.error("Fetcher call failed:", e);
    return [];
  }
}

export async function wrapNewsletter(
  html: string,
  env: Env
): Promise<WrapResult> {
  let processedHtml = stripForwardingWrapper(html);
  processedHtml = fixMojibake(processedHtml);

  processedHtml = processedHtml
    .replace(/background-color:\s*rgb\(204,\s*204,\s*204\);?/gi, "")
    .replace(/x-msg:\/\/\d+\//gi, "")
    .replace(/<span class="Apple-converted-space">[^<]*<\/span>/gi, " ");

  processedHtml = processedHtml.replace(
    /<img[^>]*alt=["']Listen to the money stuff podcast["'][^>]*>/gi,
    ""
  );

  processedHtml = processedHtml
    .replace(
      /You received this message because you are subscribed to Bloomberg[^<]*<\/\w+>/gi,
      ""
    )
    .replace(/Ads Powered By Liveintent[^<]*Ad Choices/gi, "")
    .replace(/Bloomberg L\.P\.\s*731 Lexington[^<]*10022/gi, "")
    .replace(/<a[^>]*>Unsubscribe<\/a>/gi, "")
    .replace(/<a[^>]*>Contact Us<\/a>/gi, "");

  // Extract all links
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
    if (!url || shouldSkipUrl(url)) continue;

    linksToProcess.push({
      match: match[0],
      url,
      text: text || "",
      fullMatch: match[0],
    });
  }

  // Get unique URLs to process (reversed - important links at end first)
  const uniqueUrls = [...new Set(linksToProcess.map((l) => l.url))].reverse();

  console.log(`Processing ${uniqueUrls.length} links via 3 fetcher workers...`);

  // Prepare items for fetchers
  const fetchItems = uniqueUrls.map((url) => {
    const link = linksToProcess.find((l) => l.url === url);
    return {
      url,
      text: link?.text,
      fetchOgImage: false,
    };
  });

  // Split into 3 chunks and fan out (each fetch() = new execution with own subrequest budget)
  const chunks = chunkArray(fetchItems, 3);

  const fetchPromises = chunks.map((chunk) =>
    callFetcher(env.FETCHER, chunk, env.PERPLEXITY_API_KEY)
  );

  const results = await Promise.all(fetchPromises);
  const allResults = results.flat();

  console.log(`  ✓ Got ${allResults.length} results from fetchers`);

  // Build lookup map
  const enrichedData = new Map<string, EnrichedLinkData>();
  for (const result of allResults) {
    enrichedData.set(result.originalUrl, {
      originalUrl: result.originalUrl,
      resolvedUrl: result.resolvedUrl,
      summary: result.summary,
      archiveUrl: result.archiveUrl,
      favicon: result.favicon,
    });
  }

  // Apply enrichments to HTML
  for (const link of linksToProcess) {
    const data = enrichedData.get(link.url);
    if (!data) continue;

    const newLinkHtml = generateEnrichedLink(link.fullMatch, link.text, data);
    processedHtml = processedHtml.replace(link.fullMatch, newLinkHtml);
  }

  processedHtml = processedHtml.replace(
    />View in browser<\/a>/gi,
    ">View enhanced version</a>"
  );

  processedHtml = processFootnotes(processedHtml);

  // Extract preview
  const textContent = processedHtml
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const preview = textContent.slice(0, 200).trim();

  // Fetch OG images via fetcher (pick first 5 non-paywalled URLs)
  const ogCandidates = allResults
    .filter(
      (r) =>
        r.resolvedUrl &&
        !r.resolvedUrl.includes("bloomberg.com/opinion/newsletters")
    )
    .slice(0, 5)
    .map((r) => ({ url: r.resolvedUrl, fetchOgImage: true }));

  let ogImage: string | undefined;
  if (ogCandidates.length > 0) {
    console.log(`🖼️ Fetching OG images from ${ogCandidates.length} URLs...`);
    const ogResults = await callFetcher(
      env.FETCHER,
      ogCandidates,
      env.PERPLEXITY_API_KEY
    );
    ogImage = ogResults.find((r) => r.ogImage)?.ogImage;
    if (ogImage) {
      console.log(`📸 Got OG image`);
    }
  }

  return { html: processedHtml, preview, ogImage };
}

function processFootnotes(html: string): string {
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
    const replacement = `<sup><details style="display:inline-block;vertical-align:baseline;margin:0;padding:0;"><summary style="cursor:pointer;color:#1976d2;list-style:none;display:inline;font-size:11px;margin:0;padding:0;">[${num}]</summary><span style="font-size:12px;color:#555;background:#f5f5f5;padding:2px 6px;border-radius:3px;margin-left:2px;">${escapeHtml(content)}</span></details></sup>`;
    result = result.replace(refPattern, replacement);
  }

  result = result.replace(
    /<div\s+id="footnote-\d+"[^>]*>[\s\S]*?<\/div>/gi,
    ""
  );
  return result;
}

function generateEnrichedLink(
  originalLinkHtml: string,
  linkText: string,
  data: EnrichedLinkData
): string {
  const hasText = linkText && linkText.length >= 3;

  const faviconHtml =
    data.favicon && hasText
      ? `<img src="${data.favicon}" style="width:20px;height:20px;vertical-align:middle;margin-right:6px;border:0;" alt="">`
      : "";

  let updatedLink = originalLinkHtml
    .replace(/href=(["'])([^"']+)\1/, `href=$1${data.resolvedUrl}$1`)
    .replace(/target=["'][^"']*["']/gi, "")
    .replace(/<a\s+/, '<a target="_blank" rel="noopener" ');

  if (hasText && faviconHtml) {
    const linkTextEscaped = linkText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    updatedLink = updatedLink.replace(
      new RegExp(`>\\s*(${linkTextEscaped})`),
      `>${faviconHtml}$1`
    );
  }

  let result = updatedLink;

  if (data.summary && hasText) {
    const fullText = data.summary.replace(/\s+/g, " ").trim();
    const sentences = fullText.match(/[^.!?]+[.!?]+/g) || [fullText];
    const previewText = sentences.slice(0, 2).join(" ").trim();
    const hasMore = sentences.length > 2;
    const restText = sentences.slice(2).join(" ").trim();

    const archiveLink = data.archiveUrl
      ? `<a href="${data.archiveUrl}" target="_blank" rel="noopener" style="text-decoration:none;font-size:13px;vertical-align:middle;margin-right:4px;" title="Read archived (no paywall)">📰</a>`
      : "";

    result += `${archiveLink}<details style="display:inline-block;vertical-align:baseline;margin:0;padding:0;"><summary style="cursor:pointer;list-style:none;display:inline;margin:0;padding:0;">💡</summary><span style="font-size:13px;color:#444;margin-left:4px;">${escapeHtml(previewText)}`;
    if (hasMore) {
      result += ` <details style="display:inline;margin:0;padding:0;"><summary style="cursor:pointer;color:#1976d2;font-size:11px;list-style:none;display:inline;margin:0;padding:0;">[more]</summary><span>${escapeHtml(restText)}</span></details>`;
    }
    result += ` <a href="${data.resolvedUrl}" target="_blank" rel="noopener" style="color:#1976d2;font-size:11px;text-decoration:none;">[read]</a>`;
    if (data.archiveUrl) {
      result += ` <a href="${data.archiveUrl}" target="_blank" rel="noopener" style="color:#2e7d32;font-size:11px;text-decoration:none;">[archive]</a>`;
    }
    result += `</span></details>`;
  } else if (data.archiveUrl && hasText) {
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
