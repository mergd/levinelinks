import type { Env } from "../types";

export const ISSUES_INDEX_KEY = "issues-index.json";

export type IssueIndexFile = {
  dates: string[];
};

export async function getIssueDates(env: Env): Promise<string[]> {
  const obj = await env.NEWSLETTERS.get(ISSUES_INDEX_KEY);
  if (!obj) return [];
  try {
    const parsed = JSON.parse(await obj.text()) as IssueIndexFile;
    return Array.isArray(parsed.dates) ? parsed.dates : [];
  } catch {
    return [];
  }
}

export async function putIssueAndUpdateIndex(
  env: Env,
  date: string,
  html: string,
  metaJson: string
): Promise<void> {
  await env.NEWSLETTERS.put(`${date}.html`, html, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });
  await env.NEWSLETTERS.put(`${date}.json`, metaJson, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });

  const existing = await getIssueDates(env);
  const next = [...new Set([...existing, date])].sort((a, b) =>
    b.localeCompare(a)
  );
  const index: IssueIndexFile = { dates: next };
  await env.NEWSLETTERS.put(ISSUES_INDEX_KEY, JSON.stringify(index), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

export async function getNewsletterHtml(
  env: Env,
  date: string
): Promise<string | null> {
  const obj = await env.NEWSLETTERS.get(`${date}.html`);
  if (!obj) return null;
  return obj.text();
}

export async function getNewsletterMetaJson(
  env: Env,
  date: string
): Promise<string | null> {
  const obj = await env.NEWSLETTERS.get(`${date}.json`);
  if (!obj) return null;
  return obj.text();
}
