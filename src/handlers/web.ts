import { eq } from "drizzle-orm";
import { formatDistanceToNow, differenceInDays } from "date-fns";
import { getDb } from "../db";
import { subscribers } from "../db/schema";
import { createResendClient } from "../services/mailer";
import { pruneExpiredUnverified } from "./maintenance";
import type { Env } from "../types";

const HOME_ISSUE_LIMIT = 5;
const ARCHIVE_PAGE_SIZE = 25;
const RSS_FEED_LIMIT = 50;

export async function handleFetch(
  request: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/" || path === "") {
    const message = url.searchParams.get("msg");
    return handleHome(env, message);
  }

  if (path === "/archive") {
    const page = parsePositiveInt(url.searchParams.get("page")) ?? 1;
    return handleArchive(env, page);
  }

  if (path === "/rss.xml") {
    return handleRss(env);
  }

  if (path === "/subscribe" && request.method === "POST") {
    return handleSubscribe(request, env);
  }

  if (path === "/verify") {
    return handleVerify(url, env);
  }

  if (path === "/unsubscribe") {
    return handleUnsubscribe(url, env);
  }

  if (path.startsWith("/newsletter/")) {
    const date = path.replace("/newsletter/", "");
    return handleNewsletter(date, env);
  }

  return new Response("Not Found", { status: 404 });
}

async function handleHome(
  env: Env,
  message?: string | null
): Promise<Response> {
  const issues = await getAllIssues(env);
  const latestIssues = issues.slice(0, HOME_ISSUE_LIMIT);
  const messageHtml = message
    ? `<div class="msg">${escapeHtml(message)}</div>`
    : "";
  const content = `
  <div class="sub">
    <p>Matt Levine's newsletter with AI summaries for paywalled articles.</p>
    <p style="font-size:11px;color:#777;margin-top:-8px;margin-bottom:10px;text-align:center;">Every issue includes a one-click unsubscribe link.</p>
    <form action="/subscribe" method="POST">
      <input type="email" name="email" placeholder="your@email.com" required>
      <button>Subscribe</button>
    </form>
    ${messageHtml}
  </div>
  <section>
    <div class="section-head">
      <h2>Latest Issues</h2>
      <div class="section-links">
        <a href="/archive">Archive</a>
        <a href="/rss.xml">RSS</a>
      </div>
    </div>
    <div class="issues">${renderIssueList(latestIssues, true)}</div>
  </section>
  ${
    issues.length > HOME_ISSUE_LIMIT
      ? `<div class="pager">
          <a class="pager-link" href="/archive">Browse all ${issues.length} issues</a>
        </div>`
      : ""
  }`;

  return renderSitePage("Levine Links", content);
}

async function handleArchive(env: Env, page: number): Promise<Response> {
  const issues = await getAllIssues(env);
  const totalPages = Math.max(1, Math.ceil(issues.length / ARCHIVE_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * ARCHIVE_PAGE_SIZE;
  const pageIssues = issues.slice(start, start + ARCHIVE_PAGE_SIZE);

  const prevHref =
    currentPage > 1
      ? currentPage === 2
        ? "/archive"
        : `/archive?page=${currentPage - 1}`
      : undefined;
  const nextHref =
    currentPage < totalPages ? `/archive?page=${currentPage + 1}` : undefined;

  const content = `
  <section>
    <div class="section-head">
      <div>
        <h2>Archive</h2>
        <p class="section-copy">Every issue, newest first.</p>
      </div>
      <div class="section-links">
        <a href="/">Home</a>
        <a href="/rss.xml">RSS</a>
      </div>
    </div>
    <div class="issues">${renderIssueList(pageIssues, false)}</div>
  </section>
  <div class="pager">
    <span class="pager-meta">Page ${currentPage} of ${totalPages}</span>
    ${
      prevHref
        ? `<a class="pager-link" href="${prevHref}">Newer</a>`
        : `<span class="pager-link is-disabled">Newer</span>`
    }
    ${
      nextHref
        ? `<a class="pager-link" href="${nextHref}">Older</a>`
        : `<span class="pager-link is-disabled">Older</span>`
    }
  </div>`;

  return renderSitePage("Archive - Levine Links", content);
}

async function handleRss(env: Env): Promise<Response> {
  const issues = (await getAllIssues(env)).slice(0, RSS_FEED_LIMIT);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Levine Links</title>
    <link>${escapeXml(env.SITE_URL)}</link>
    <description>Matt Levine's Money Stuff, enhanced with paywall-friendly summaries.</description>
    <language>en-us</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${escapeXml(env.SITE_URL)}/rss.xml" rel="self" type="application/rss+xml" xmlns:atom="http://www.w3.org/2005/Atom" />
    ${issues.map((issue) => renderRssItem(issue, env)).join("\n    ")}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
    },
  });
}

interface Issue {
  date: string;
  subject: string;
  preview?: string;
  ogImage?: string;
}

interface IssueNavigation {
  newer?: Issue;
  older?: Issue;
}

async function getAllIssues(env: Env): Promise<Issue[]> {
  const issues: Issue[] = [];
  let cursor: string | undefined;

  do {
    const list = await env.NEWSLETTERS.list({ cursor });
    cursor = list.list_complete ? undefined : list.cursor;

    for (const key of list.keys) {
      if (!key.name.endsWith(".json")) continue;
      const data = await env.NEWSLETTERS.get(key.name);
      if (!data) continue;

      try {
        const parsed = JSON.parse(data);
        issues.push({
          date: parsed.date,
          subject: parsed.subject,
          preview: parsed.preview,
          ogImage: parsed.ogImage,
        });
      } catch {}
    }
  } while (cursor);

  return issues.sort((a, b) => b.date.localeCompare(a.date));
}

function formatDate(dateStr: string, relative: boolean = false): string {
  const date = new Date(dateStr + "T12:00:00");
  const now = new Date();
  const daysDiff = differenceInDays(now, date);

  // Show relative date if within 14 days
  if (relative && daysDiff >= 0 && daysDiff < 14) {
    if (daysDiff === 0) return "Today";
    if (daysDiff === 1) return "Yesterday";
    return formatDistanceToNow(date, { addSuffix: true });
  }

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function renderSitePage(title: string, content: string): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <link rel="alternate" type="application/rss+xml" title="Levine Links RSS" href="/rss.xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Newsreader:wght@500;600&family=Inter:wght@400;500&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Inter',system-ui,sans-serif;background:#f5f5f0;color:#292929;font-size:15px;line-height:1.5;min-height:100vh}
    .wrap{max-width:560px;margin:0 auto;padding:48px 20px 56px}
    header{margin-bottom:28px;text-align:center}
    h1{font-family:'Newsreader',Georgia,serif;font-size:32px;font-weight:600;letter-spacing:-0.5px;margin-bottom:4px}
    .tag{color:#666;font-size:14px}
    .sub{background:#fff;border-radius:12px;padding:20px;margin-bottom:32px;box-shadow:0 1px 3px rgba(0,0,0,.08),0 10px 30px rgba(0,0,0,.04)}
    .sub p{font-size:13px;color:#555;margin-bottom:12px;text-align:center}
    .msg{font-size:11px;color:#666;margin:10px 0 0;text-align:center}
    form{display:flex;border-radius:8px;overflow:hidden;box-shadow:inset 0 1px 2px rgba(0,0,0,.1),0 1px 0 rgba(255,255,255,.8)}
    input{flex:1;padding:12px 14px;border:1px solid #ccc;border-right:none;border-radius:8px 0 0 8px;font-size:14px;font-family:inherit;background:#fafafa;box-shadow:inset 0 1px 3px rgba(0,0,0,.06)}
    input:focus{outline:none;background:#fff;border-color:#999}
    input::placeholder{color:#999}
    button{padding:12px 20px;background:linear-gradient(180deg,#444 0%,#222 100%);color:#fff;border:1px solid #111;border-radius:0 8px 8px 0;font-size:14px;font-weight:500;cursor:pointer;box-shadow:inset 0 1px 0 rgba(255,255,255,.15),0 1px 2px rgba(0,0,0,.2);text-shadow:0 -1px 0 rgba(0,0,0,.3);transition:all .1s}
    button:hover{background:linear-gradient(180deg,#555 0%,#333 100%)}
    button:active{background:linear-gradient(180deg,#222 0%,#333 100%);box-shadow:inset 0 2px 4px rgba(0,0,0,.3)}
    section{margin-bottom:24px}
    .section-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:10px}
    h2{font-family:'Newsreader',Georgia,serif;font-size:16px;font-weight:600;color:#292929}
    .section-copy{font-size:11px;color:#777;margin-top:2px}
    .section-links{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
    .section-links a,.pager-link{color:#555;text-decoration:none;font-size:12px;padding:7px 11px;background:#fff;border:1px solid #ddd;border-radius:999px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
    .section-links a:hover,.pager-link:hover{background:#fafafa}
    .issues{display:flex;flex-direction:column;gap:12px}
    .issue{display:flex;gap:14px;padding:14px;background:#fff;border-radius:12px;text-decoration:none;color:inherit;transition:all .15s;box-shadow:0 1px 3px rgba(0,0,0,.06)}
    .issue:hover{box-shadow:0 10px 28px rgba(0,0,0,.08);transform:translateY(-1px)}
    .issue .thumb{width:72px;height:54px;border-radius:8px;flex-shrink:0;object-fit:cover;background:#eee}
    .issue-content{flex:1;min-width:0}
    .issue .date{font-size:10px;color:#999;display:block;margin-bottom:3px;text-transform:uppercase;letter-spacing:0.5px}
    .issue .title{font-family:'Newsreader',Georgia,serif;font-size:15px;font-weight:500;color:#292929;display:block;margin-bottom:4px;line-height:1.3}
    .issue .preview{font-size:12px;color:#777;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.4}
    .empty{color:#999;font-size:14px;padding:20px;text-align:center;background:#fff;border-radius:12px}
    .pager{display:flex;gap:10px;align-items:center;justify-content:center;flex-wrap:wrap;margin-top:24px}
    .pager-meta{font-size:11px;color:#888}
    .pager-link.is-disabled{color:#aaa;background:#f3f3f0;border-color:#e3e3df;pointer-events:none}
    footer{margin-top:36px;font-size:11px;color:#999;text-align:center}
    footer a{color:#777}
    @media (max-width: 560px){
      .section-head{align-items:flex-start;flex-direction:column}
      .section-links{width:100%}
    }
  </style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Levine Links</h1>
    <p class="tag">Money Stuff, enhanced</p>
  </header>
  ${content}
  <footer>A <a href="https://fldr.zip">fldr.zip</a> project · Not affiliated with Bloomberg</footer>
</div>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function renderIssueList(issues: Issue[], relativeDates: boolean): string {
  const defaultImg =
    "https://assets.bwbx.io/images/users/iqjWHBFdfxIU/iELnhicC0ZBk/v0/80x80.jpg";

  if (issues.length === 0) {
    return '<p class="empty">No issues yet</p>';
  }

  return issues
    .map(
      (issue) =>
        `<a href="/newsletter/${issue.date}" class="issue">
          <img src="${issue.ogImage || defaultImg}" alt="" class="thumb" onerror="this.src='${defaultImg}'">
          <div class="issue-content">
            <span class="date">${formatDate(issue.date, relativeDates)}</span>
            <span class="title">${escapeHtml(issue.subject.replace(/^(Money Stuff:\s*|Fwd:\s*)/gi, ""))}</span>
            <span class="preview">${escapeHtml(issue.preview || "")}</span>
          </div>
        </a>`
    )
    .join("");
}

function renderRssItem(issue: Issue, env: Env): string {
  const cleanSubject = issue.subject.replace(/^(Money Stuff:\s*|Fwd:\s*)/gi, "").trim();
  const issueUrl = `${env.SITE_URL}/newsletter/${issue.date}`;
  const pubDate = new Date(`${issue.date}T12:00:00Z`).toUTCString();
  const description = issue.preview || "Matt Levine's newsletter with AI-enhanced summaries.";

  return `<item>
      <title>${escapeXml(cleanSubject)}</title>
      <link>${escapeXml(issueUrl)}</link>
      <guid>${escapeXml(issueUrl)}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${escapeXml(description)}</description>
    </item>`;
}

async function getIssueNavigation(
  env: Env,
  date: string
): Promise<IssueNavigation> {
  const issues = await getAllIssues(env);
  const index = issues.findIndex((issue) => issue.date === date);

  if (index === -1) {
    return {};
  }

  return {
    newer: index > 0 ? issues[index - 1] : undefined,
    older: index < issues.length - 1 ? issues[index + 1] : undefined,
  };
}

function parsePositiveInt(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  return parsed;
}

async function handleSubscribe(request: Request, env: Env): Promise<Response> {
  const formData = await request.formData();
  const email = formData.get("email")?.toString().toLowerCase().trim();

  if (!email || !email.includes("@")) {
    return new Response("Invalid email", { status: 400 });
  }

  const db = getDb(env.DB);
  await pruneExpiredUnverified(env);

  const existing = await db
    .select()
    .from(subscribers)
    .where(eq(subscribers.email, email))
    .get();
  if (existing) {
    if (existing.verified) {
      return redirectWithMessage(`${email} is already subscribed.`);
    }

    const verifyToken = existing.verifyToken || crypto.randomUUID();
    if (!existing.verifyToken) {
      await db
        .update(subscribers)
        .set({ verifyToken })
        .where(eq(subscribers.id, existing.id));
    }

    await sendVerificationEmail(env, email, verifyToken);
    return redirectWithMessage("You're almost subscribed. Check your email to verify.");
  }

  const verifyToken = crypto.randomUUID();
  const unsubscribeToken = crypto.randomUUID();

  await db.insert(subscribers).values({
    email,
    verifyToken,
    unsubscribeToken,
  });

  await sendVerificationEmail(env, email, verifyToken);

  return redirectWithMessage("Check your email to verify!");
}

async function sendVerificationEmail(
  env: Env,
  email: string,
  verifyToken: string
): Promise<void> {
  const resend = createResendClient(env.RESEND_API_KEY);
  await resend.emails.send({
    from: `Levine Links <newsletter@${env.EMAIL_DOMAIN}>`,
    to: email,
    subject: "Verify your subscription",
    html: `
      <p>Click below to verify your subscription to Levine Links:</p>
      <p><a href="${env.SITE_URL}/verify?token=${verifyToken}">Verify Email</a></p>
    `,
  });
}

async function handleVerify(url: URL, env: Env): Promise<Response> {
  const token = url.searchParams.get("token");
  if (!token) {
    return new Response("Missing token", { status: 400 });
  }

  const db = getDb(env.DB);
  const subscriber = await db
    .select()
    .from(subscribers)
    .where(eq(subscribers.verifyToken, token))
    .get();

  if (!subscriber) {
    return new Response("Invalid token", { status: 400 });
  }

  await db
    .update(subscribers)
    .set({ verified: true, verifyToken: null })
    .where(eq(subscribers.id, subscriber.id));

  return redirectWithMessage("You're subscribed!");
}

async function handleUnsubscribe(url: URL, env: Env): Promise<Response> {
  const token = url.searchParams.get("token");
  if (!token) {
    return new Response("Missing token", { status: 400 });
  }

  const db = getDb(env.DB);
  await db.delete(subscribers).where(eq(subscribers.unsubscribeToken, token));

  return redirectWithMessage("You've been unsubscribed.");
}

async function handleNewsletter(date: string, env: Env): Promise<Response> {
  const html = await env.NEWSLETTERS.get(`${date}.html`);
  const metaJson = await env.NEWSLETTERS.get(`${date}.json`);

  if (!html) {
    return new Response("Newsletter not found", { status: 404 });
  }

  let subject = "Money Stuff";
  if (metaJson) {
    try {
      const meta = JSON.parse(metaJson);
      subject = meta.subject || subject;
    } catch {}
  }

  const textContent = html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const preview = textContent.slice(0, 180).trim() + "...";
  const cleanSubject = subject
    .replace(/^(Money Stuff:\s*|Fwd:\s*)/gi, "")
    .trim();
  const nav = await getIssueNavigation(env, date);

  const headContent = `
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="color-scheme" content="light only">
    <meta property="og:title" content="${escapeHtml(cleanSubject)}">
    <meta property="og:description" content="${escapeHtml(preview)}">
    <meta property="og:type" content="article">
    <meta property="og:url" content="${env.SITE_URL}/newsletter/${date}">
    <meta property="og:image" content="https://assets.bwbx.io/images/users/iqjWHBFdfxIU/iELnhicC0ZBk/v0/-1x-1.jpg">
    <meta property="og:site_name" content="Levine Links">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeHtml(cleanSubject)}">
    <meta name="twitter:description" content="${escapeHtml(preview)}">
    <meta name="twitter:image" content="https://assets.bwbx.io/images/users/iqjWHBFdfxIU/iELnhicC0ZBk/v0/-1x-1.jpg">
    <title>${escapeHtml(cleanSubject)} - Levine Links</title>
    <style>
      :root { color-scheme: light only; }
      html, body { background: #fff !important; color: #1a1a1a !important; }
    </style>
  `;

  const backButton = `
    <div style="position:sticky;top:0;z-index:1000;background:#f8f8f8;padding:12px 20px;font-family:'Inter',-apple-system,sans-serif;display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid #ddd;box-shadow:0 1px 4px rgba(0,0,0,0.08);flex-wrap:wrap;">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <a href="/archive" style="display:inline-flex;align-items:center;gap:8px;color:#333;text-decoration:none;font-size:13px;font-weight:500;padding:7px 12px;background:#fff;border:1px solid #ddd;border-radius:999px;transition:background 0.15s;">
          <span style="font-size:15px;">&larr;</span>
          <span>Archive</span>
        </a>
        ${
          nav.newer
            ? `<a href="/newsletter/${nav.newer.date}" style="display:inline-flex;align-items:center;gap:6px;color:#333;text-decoration:none;font-size:13px;padding:7px 12px;background:#fff;border:1px solid #ddd;border-radius:999px;">
                <span>&larr;</span>
                <span>Newer</span>
              </a>`
            : ""
        }
        ${
          nav.older
            ? `<a href="/newsletter/${nav.older.date}" style="display:inline-flex;align-items:center;gap:6px;color:#333;text-decoration:none;font-size:13px;padding:7px 12px;background:#fff;border:1px solid #ddd;border-radius:999px;">
                <span>Older</span>
                <span>&rarr;</span>
              </a>`
            : ""
        }
      </div>
      <span style="color:#666;font-size:12px;">${formatDate(date)}</span>
    </div>`;

  // Build proper HTML document structure
  let wrappedHtml: string;

  if (html.includes("<!DOCTYPE") || html.includes("<html")) {
    // Has HTML structure - inject into existing head/body
    wrappedHtml = html.includes("<head>")
      ? html.replace(/<head>/i, `<head>${headContent}`)
      : html.replace(/<html([^>]*)>/i, `<html$1><head>${headContent}</head>`);

    wrappedHtml = wrappedHtml.includes("<body")
      ? wrappedHtml.replace(/<body([^>]*)>/i, `<body$1>${backButton}`)
      : wrappedHtml.replace(/<\/head>/i, `</head><body>${backButton}`) +
        "</body>";
  } else {
    // No HTML structure - wrap entirely
    wrappedHtml = `<!DOCTYPE html>
<html lang="en">
<head>${headContent}</head>
<body style="margin:0;padding:0;">
${backButton}
<div style="max-width:650px;margin:0 auto;padding:20px;">
${html}
</div>
</body>
</html>`;
  }

  return new Response(wrappedHtml, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function redirectWithMessage(message: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: `/?msg=${encodeURIComponent(message)}` },
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeXml(text: string): string {
  return escapeHtml(text).replace(/'/g, "&apos;");
}
