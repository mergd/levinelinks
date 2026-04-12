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

