import PostalMime from "postal-mime";
import { getDb } from "../db";
import { subscribers } from "../db/schema";
import { wrapNewsletter } from "../services/wrapper";
import { createResendClient } from "../services/mailer";
import { stripForwardedHeaders } from "../services/parser";
import type { Env } from "../types";

const ALLOWED_SENDERS = ["noreply@news.bloomberg.com", "noreply@bloomberg.net"];

export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const from = message.from.toLowerCase();
  console.log(`📧 Received email from: ${from}`);

  // Allow seed email to forward previous issues
  const isSeedEmail =
    env.SEED_EMAIL && from.includes(env.SEED_EMAIL.toLowerCase());
  const isBloombergNewsletter = ALLOWED_SENDERS.some((allowed) =>
    from.includes(allowed)
  );

  if (isBloombergNewsletter) {
    console.log(`Processing newsletter from: ${from}`);
    ctx.waitUntil(processNewsletter(message, env, true));
    return;
  }

  if (isSeedEmail) {
    console.log(`Processing forwarded issue from seed: ${from}`);
    ctx.waitUntil(processNewsletter(message, env, false));
    return;
  }

  // Forward any other email to seed email (for Bloomberg verification, etc)
  if (env.SEED_EMAIL) {
    console.log(`Forwarding email to ${env.SEED_EMAIL}`);
    ctx.waitUntil(forwardEmail(message, env));
    return;
  }

  console.log(`Ignoring email from: ${from}`);
}

async function processNewsletter(
  message: ForwardableEmailMessage,
  env: Env,
  sendToSubscribers: boolean = true
): Promise<void> {
  try {
    const rawEmail = await streamToString(message.raw);
    const parser = new PostalMime();
    const parsed = await parser.parse(rawEmail);

    const rawHtml = parsed.html || parsed.text || "";
    const originalHtml = stripForwardedHeaders(rawHtml);
    // Strip "Fwd:" prefix from subject
    const subject = (parsed.subject || "Money Stuff")
      .replace(/^(Fwd?:\s*)+/gi, "")
      .trim();

    // Skip podcast emails
    if (subject.toLowerCase().includes("the podcast")) {
      console.log(`Skipping podcast email: ${subject}`);
      return;
    }

    // Extract original newsletter date (not the forwarding date)
    const date = extractNewsletterDate(rawHtml, parsed.date);

    console.log(`Processing: ${subject} (${date})`);

    // Process all links (3 parallel fetchers handle subrequest limits)
    const result = await wrapNewsletter(originalHtml, env);

    await env.NEWSLETTERS.put(`${date}.html`, result.html);
    await env.NEWSLETTERS.put(
      `${date}.json`,
      JSON.stringify({
        date,
        subject,
        preview: result.preview,
        ogImage: result.ogImage,
        processedAt: new Date().toISOString(),
      })
    );

    if (!sendToSubscribers) {
      console.log(`Seeded: ${subject} (${date}) - not sending to subscribers`);
      return;
    }

    const db = getDb(env.DB);
    const allSubscribers = await db.select().from(subscribers);
    const verifiedSubscribers = allSubscribers.filter((s) => s.verified);

    console.log(`Sending to ${verifiedSubscribers.length} subscribers`);

    const resend = createResendClient(env.RESEND_API_KEY);

    for (const subscriber of verifiedSubscribers) {
      const unsubscribeUrl = `${env.SITE_URL}/unsubscribe?token=${subscriber.unsubscribeToken}`;
      const emailHtml = addFooter(
        result.html,
        env.SITE_URL,
        date,
        unsubscribeUrl
      );

      await resend.emails.send({
        from: "Levine Links <newsletter@yet-to-be.com>",
        to: subscriber.email,
        subject,
        html: emailHtml,
      });
    }

    console.log(`Done: ${subject} (${date})`);
  } catch (error) {
    console.error(`❌ Error processing newsletter:`, error);
    throw error;
  }
}

function addFooter(
  html: string,
  siteUrl: string,
  date: string,
  unsubscribeUrl: string
): string {
  const footer = `
    <div style="margin-top: 40px; padding: 24px; background: #f9f9f9; border-radius: 8px; font-family: -apple-system, sans-serif;">
      <p style="font-size: 15px; color: #333; margin: 0 0 12px 0; text-align: center;">
        <strong>Like Levine Links?</strong> Share with a friend 👇
      </p>
      <p style="font-size: 14px; margin: 0 0 16px 0; text-align: center;">
        <a href="${siteUrl}" style="color: #1976d2; text-decoration: none; font-weight: 500;">${siteUrl.replace("https://", "")}</a>
      </p>
      <p style="font-size: 11px; color: #888; margin: 0; text-align: center;">
        <a href="${siteUrl}/newsletter/${date}" style="color: #888;">View on web</a> · 
        <a href="${unsubscribeUrl}" style="color: #888;">Unsubscribe</a>
      </p>
    </div>
  `;

  if (html.includes("</body>")) {
    return html.replace("</body>", `${footer}</body>`);
  }
  return html + footer;
}

async function forwardEmail(
  message: ForwardableEmailMessage,
  env: Env
): Promise<void> {
  const rawEmail = await streamToString(message.raw);
  const parser = new PostalMime();
  const parsed = await parser.parse(rawEmail);

  const resend = createResendClient(env.RESEND_API_KEY);

  await resend.emails.send({
    from: "Levine Links <newsletter@yet-to-be.com>",
    to: env.SEED_EMAIL!,
    subject: `[FWD] ${parsed.subject || "No Subject"}`,
    html: parsed.html || parsed.text || "No content",
  });

  console.log(`Forwarded: ${parsed.subject}`);
}

function extractNewsletterDate(
  html: string,
  fallbackDate?: Date | string
): string {
  // Gmail forward format: "Date: Tue, Nov 25, 2025 at 10:42 AM"
  const gmailMatch = html.match(
    /Date:\s*(?:\w+,\s*)?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})/i
  );
  if (gmailMatch) {
    const parsed = new Date(
      `${gmailMatch[1]} ${gmailMatch[2]}, ${gmailMatch[3]}`
    );
    if (!isNaN(parsed.getTime())) {
      console.log(
        `📅 Extracted date from Gmail forward: ${gmailMatch[1]} ${gmailMatch[2]}, ${gmailMatch[3]}`
      );
      return parsed.toISOString().split("T")[0];
    }
  }

  // Full month format: "Date: November 24, 2025"
  const fullMonthMatch = html.match(
    /Date:\s*(?:\w+,\s*)?(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i
  );
  if (fullMonthMatch) {
    const parsed = new Date(
      `${fullMonthMatch[1]} ${fullMonthMatch[2]}, ${fullMonthMatch[3]}`
    );
    if (!isNaN(parsed.getTime())) {
      console.log(`📅 Extracted date from header: ${fullMonthMatch[0]}`);
      return parsed.toISOString().split("T")[0];
    }
  }

  // Try to find date in Bloomberg newsletter URL: /2025-11-24/
  const urlDateMatch =
    html.match(/\/(\d{4}-\d{2}-\d{2})\//) ||
    html.match(/newsletters\/(\d{4}-\d{2}-\d{2})/);

  if (urlDateMatch) {
    console.log(`📅 Extracted date from URL: ${urlDateMatch[1]}`);
    return urlDateMatch[1];
  }

  // Fallback to email date or today
  const date = fallbackDate ? new Date(fallbackDate) : new Date();
  console.log(`📅 Using fallback date: ${date.toISOString().split("T")[0]}`);
  return date.toISOString().split("T")[0];
}

async function streamToString(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return new TextDecoder().decode(result);
}
