import { eq } from "drizzle-orm";
import { formatDistanceToNow, differenceInDays } from "date-fns";
import { getDb } from "../db";
import { subscribers } from "../db/schema";
import { createResendClient } from "../services/mailer";
import type { Env } from "../types";

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
  const issues = await getRecentIssues(env);

  const defaultImg =
    "https://assets.bwbx.io/images/users/iqjWHBFdfxIU/iELnhicC0ZBk/v0/80x80.jpg";
  const issueList =
    issues.length > 0
      ? issues
          .map(
            (issue) =>
              `<a href="/newsletter/${issue.date}" class="issue">
                <img src="${issue.ogImage || defaultImg}" alt="" class="thumb" onerror="this.src='${defaultImg}'">
                <div class="issue-content">
                  <span class="date">${formatDate(issue.date, true)}</span>
                  <span class="title">${escapeHtml(issue.subject.replace(/^(Money Stuff:\s*|Fwd:\s*)/gi, ""))}</span>
                  <span class="preview">${escapeHtml(issue.preview || "")}</span>
                </div>
              </a>`
          )
          .join("")
      : '<p class="empty">No issues yet</p>';

  const messageHtml = message
    ? `<div class="msg">${escapeHtml(message)}</div>`
    : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Levine Links</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Newsreader:wght@500;600&family=Inter:wght@400;500&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Inter',system-ui,sans-serif;background:#f5f5f0;color:#292929;font-size:15px;line-height:1.5;min-height:100vh}
    .wrap{max-width:480px;margin:0 auto;padding:48px 20px}
    header{margin-bottom:28px;text-align:center}
    h1{font-family:'Newsreader',Georgia,serif;font-size:32px;font-weight:600;letter-spacing:-0.5px;margin-bottom:4px}
    .tag{color:#666;font-size:14px}
    .sub{background:#fff;border-radius:8px;padding:20px;margin-bottom:32px;box-shadow:0 1px 3px rgba(0,0,0,.08),0 4px 12px rgba(0,0,0,.04)}
    .sub p{font-size:14px;color:#555;margin-bottom:14px;text-align:center}
    .msg{font-size:12px;color:#666;margin:12px 0 0;text-align:center}
    form{display:flex;border-radius:6px;overflow:hidden;box-shadow:inset 0 1px 2px rgba(0,0,0,.1),0 1px 0 rgba(255,255,255,.8)}
    input{flex:1;padding:12px 14px;border:1px solid #ccc;border-right:none;border-radius:6px 0 0 6px;font-size:14px;font-family:inherit;background:#fafafa;box-shadow:inset 0 1px 3px rgba(0,0,0,.06)}
    input:focus{outline:none;background:#fff;border-color:#999}
    input::placeholder{color:#999}
    button{padding:12px 20px;background:linear-gradient(180deg,#444 0%,#222 100%);color:#fff;border:1px solid #111;border-radius:0 6px 6px 0;font-size:14px;font-weight:500;cursor:pointer;box-shadow:inset 0 1px 0 rgba(255,255,255,.15),0 1px 2px rgba(0,0,0,.2);text-shadow:0 -1px 0 rgba(0,0,0,.3);transition:all .1s}
    button:hover{background:linear-gradient(180deg,#555 0%,#333 100%)}
    button:active{background:linear-gradient(180deg,#222 0%,#333 100%);box-shadow:inset 0 2px 4px rgba(0,0,0,.3)}
    h2{font-family:'Newsreader',Georgia,serif;font-size:12px;font-weight:500;color:#888;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px}
    .issues{display:flex;flex-direction:column;gap:12px}
    .issue{display:flex;gap:14px;padding:14px;background:#fff;border-radius:8px;text-decoration:none;color:inherit;transition:all .15s;box-shadow:0 1px 3px rgba(0,0,0,.06)}
    .issue:hover{box-shadow:0 4px 12px rgba(0,0,0,.1);transform:translateY(-1px)}
    .issue .thumb{width:72px;height:54px;border-radius:6px;flex-shrink:0;object-fit:cover;background:#eee}
    .issue-content{flex:1;min-width:0}
    .issue .date{font-size:10px;color:#999;display:block;margin-bottom:3px;text-transform:uppercase;letter-spacing:0.5px}
    .issue .title{font-family:'Newsreader',Georgia,serif;font-size:15px;font-weight:500;color:#292929;display:block;margin-bottom:4px;line-height:1.3}
    .issue .preview{font-size:12px;color:#777;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.4}
    .empty{color:#999;font-size:14px;padding:20px;text-align:center;background:#fff;border-radius:8px}
    footer{margin-top:32px;font-size:11px;color:#999;text-align:center}
  </style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Levine Links</h1>
    <p class="tag">Money Stuff, enhanced</p>
  </header>
  <div class="sub">
    <p>Matt Levine's newsletter with AI summaries for paywalled articles.</p>
    <form action="/subscribe" method="POST">
      <input type="email" name="email" placeholder="your@email.com" required>
      <button>Subscribe</button>
    </form>
    ${messageHtml}
  </div>
  <section>
    <h2>Archive</h2>
    <div class="issues">${issueList}</div>
  </section>
  <footer>A <a href="https://fldr.zip" style="color:#999">fldr.zip</a> project · Not affiliated with Bloomberg</footer>
</div>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

interface Issue {
  date: string;
  subject: string;
  preview?: string;
  ogImage?: string;
}

async function getRecentIssues(env: Env): Promise<Issue[]> {
  const issues: Issue[] = [];

  const list = await env.NEWSLETTERS.list();

  for (const key of list.keys) {
    if (key.name.endsWith(".json")) {
      const data = await env.NEWSLETTERS.get(key.name);
      if (data) {
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
    }
  }

  return issues.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20);
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

async function handleSubscribe(request: Request, env: Env): Promise<Response> {
  const formData = await request.formData();
  const email = formData.get("email")?.toString().toLowerCase().trim();

  if (!email || !email.includes("@")) {
    return new Response("Invalid email", { status: 400 });
  }

  const db = getDb(env.DB);

  const existing = await db
    .select()
    .from(subscribers)
    .where(eq(subscribers.email, email))
    .get();
  if (existing) {
    return redirectWithMessage("Already subscribed!");
  }

  const verifyToken = crypto.randomUUID();
  const unsubscribeToken = crypto.randomUUID();

  await db.insert(subscribers).values({
    email,
    verifyToken,
    unsubscribeToken,
  });

  const resend = createResendClient(env.RESEND_API_KEY);
  await resend.emails.send({
    from: "Levine Links <newsletter@levinelinks.com>",
    to: email,
    subject: "Verify your subscription",
    html: `
      <p>Click below to verify your subscription to Levine Links:</p>
      <p><a href="${env.SITE_URL}/verify?token=${verifyToken}">Verify Email</a></p>
    `,
  });

  return redirectWithMessage("Check your email to verify!");
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
    <div style="position:sticky;top:0;z-index:1000;background:#f8f8f8;padding:12px 20px;font-family:'Inter',-apple-system,sans-serif;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #ddd;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
      <a href="/" style="display:inline-flex;align-items:center;gap:8px;color:#333;text-decoration:none;font-size:14px;font-weight:500;padding:8px 14px;background:#fff;border:1px solid #ddd;border-radius:6px;transition:background 0.15s;">
        <span style="font-size:16px;">&larr;</span>
        <span>All Issues</span>
      </a>
      <span style="color:#666;font-size:13px;">${formatDate(date)}</span>
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
