import type { ExtractedLink } from "../types";

const PAYWALLED_DOMAINS = [
  "wsj.com",
  "nytimes.com",
  "ft.com",
  "washingtonpost.com",
  "theathletic.com",
  "theinformation.com",
  "theatlantic.com",
  "economist.com",
  "barrons.com",
  "fortune.com",
  "businessinsider.com",
  "seekingalpha.com",
];

const TRACKING_DOMAINS = [
  "links.message.bloomberg.com",
  "bloom.bg",
  "sli.bloomberg.com",
];

export async function resolveTrackingUrl(url: string, depth = 0): Promise<string> {
  if (depth > 5) return url;

  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const isTrackingUrl = TRACKING_DOMAINS.some((d) => hostname.includes(d));

    if (!isTrackingUrl) {
      return url;
    }

    const response = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
    });

    const location = response.headers.get("location");
    if (location) {
      const resolved = location.startsWith("/")
        ? new URL(location, url).href
        : location;

      return resolveTrackingUrl(resolved, depth + 1);
    }

    return url;
  } catch {
    return url;
  }
}

export function isPaywalledUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return PAYWALLED_DOMAINS.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}

export function extractLinksFromHtml(html: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const linkRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const url = match[1];
    const rawText = match[2];

    if (!url || url.startsWith("mailto:") || url.startsWith("#")) continue;

    const text = rawText.replace(/<[^>]+>/g, "").trim();
    if (!text) continue;

    const contextStart = Math.max(0, match.index - 100);
    const contextEnd = Math.min(html.length, match.index + match[0].length + 100);
    const context = html
      .slice(contextStart, contextEnd)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    links.push({ url, text, context });
  }

  return links;
}

export function extractSubjectFromEmail(rawEmail: string): string {
  const subjectMatch = rawEmail.match(/^Subject:\s*(.+)$/im);
  return subjectMatch?.[1]?.trim() ?? "Money Stuff";
}

export function stripForwardedHeaders(html: string): string {
  let result = html;

  // Gmail class-based forwarding: extract content from gmail_quote wrapper
  // Format: <div dir="ltr">...<div class="gmail_quote...">...<div class="msg...">CONTENT</div>...</div>
  const gmailQuoteMatch = result.match(
    /<div[^>]*class="[^"]*gmail_quote[^"]*"[^>]*>([\s\S]*)<\/div>\s*<\/div>\s*$/i
  );
  if (gmailQuoteMatch) {
    let content = gmailQuoteMatch[1];
    // Extract from the innermost msg div if present
    const msgMatch = content.match(
      /<div[^>]*class="[^"]*msg\d+[^"]*"[^>]*>([\s\S]*)<\/div>/i
    );
    if (msgMatch) {
      content = msgMatch[1];
    }
    // Remove gmail_attr div (contains forwarding metadata)
    content = content.replace(
      /<div[^>]*class="[^"]*gmail_attr[^"]*"[^>]*>[\s\S]*?<\/div>/gi,
      ""
    );
    result = content;
  }

  // Apple Mail: strip outer wrapper and extract content from blockquote
  // Format: <html aria-label="message body">...<blockquote type="cite">HEADERS + CONTENT</blockquote>...</html>
  const appleMailMatch = result.match(
    /<blockquote[^>]*type="cite"[^>]*>([\s\S]*?)<\/blockquote>/i
  );
  if (appleMailMatch) {
    let content = appleMailMatch[1];
    content = content
      .replace(
        /^[\s\S]*?<div[^>]*>[\s\S]*?<b>Reply-To:\s*<\/b>[\s\S]*?<\/div>\s*<br\s*\/?>/i,
        ""
      )
      .replace(
        /^[\s\S]*?"[^"]*"\s*&lt;[^&]*&gt;[\s\S]*?Reply-To:[\s\S]*?<br\s*\/?>/i,
        ""
      );
    content = content.replace(/^<br[^>]*>/i, "");
    result = content;
  }

  // Gmail text-based: "---------- Forwarded message ---------"
  result = result.replace(
    /-{5,}\s*Forwarded message\s*-{5,}[\s\S]*?(?=<table|<div[^>]*class)/i,
    ""
  );

  // Remove "Begin forwarded message:" blocks
  const patterns = [
    /<div[^>]*>[\s\S]*?Begin forwarded message:[\s\S]*?Reply-To:[^<]*<\/div>/gi,
    /Begin forwarded message:[\s\S]*?(?:From:|Subject:|Date:|To:|Reply-To:)[^<]*(?:<br\s*\/?>[\s\S]*?){0,10}(?=<)/gi,
    /<blockquote[^>]*>[\s\S]*?Begin forwarded message:[\s\S]*?<\/blockquote>/gi,
    /Begin forwarded message:\s*(?:<br\s*\/?>|\n|\r)+(?:[\s\S]*?(?:From|Subject|Date|To|Reply-To):[^\n<]+(?:<br\s*\/?>|\n|\r)*)+/gi,
    /<[^>]*>Begin forwarded message:<\/[^>]*>[\s\S]*?<[^>]*>Reply-To:[^<]*<\/[^>]*>/gi,
  ];

  for (const pattern of patterns) {
    result = result.replace(pattern, "");
  }

  // Strip leading <br> and empty divs
  result = result
    .replace(/^(\s*<br\s*\/?>\s*)+/i, "")
    .replace(/^(\s*<div[^>]*>\s*<\/div>\s*)+/i, "");

  return result;
}

