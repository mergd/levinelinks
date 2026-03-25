/**
 * One-time: copy newsletter *.html / *.json from KV to R2 and write issues-index.json.
 * Requires CLOUDFLARE_API_TOKEN and the R2 bucket to exist.
 *
 *   npx tsx scripts/migrate-kv-newsletters-to-r2.ts
 */
import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { ISSUES_INDEX_KEY } from "../src/services/newsletter-storage";
import { R2_NEWSLETTER_BUCKET } from "./r2-config";

const KV_NAMESPACE_ID = "12fe9a29ec85487aa5d9eaeac7a8730c";

function runBuf(
  cmd: string,
  args: string[]
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => chunks.push(d));
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(chunks),
        stderr,
      });
    });
  });
}

async function wranglerText(args: string[]): Promise<string> {
  const { code, stdout, stderr } = await runBuf("npx", ["wrangler", ...args]);
  if (code !== 0) {
    throw new Error(`wrangler ${args.join(" ")} failed:\n${stderr || stdout}`);
  }
  return stdout.toString("utf8");
}

async function wranglerOk(args: string[]): Promise<void> {
  const { code, stdout, stderr } = await runBuf("npx", ["wrangler", ...args]);
  if (code !== 0) {
    throw new Error(
      `wrangler ${args.join(" ")} failed:\n${stderr || stdout.toString("utf8")}`
    );
  }
}

async function main() {
  const listOut = await wranglerText([
    "kv",
    "key",
    "list",
    "--namespace-id",
    KV_NAMESPACE_ID,
    "--remote",
  ]);

  let keyNames: string[] = [];
  const trimmed = listOut.trim();
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as { name?: string }[];
    keyNames = parsed.map((k) => k.name).filter(Boolean) as string[];
  } else {
    keyNames = trimmed
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  }

  const jsonKeys = keyNames.filter((k) => /^\d{4}-\d{2}-\d{2}\.json$/.test(k));
  const dates = jsonKeys
    .map((k) => k.replace(/\.json$/, ""))
    .sort((a, b) => b.localeCompare(a));

  await mkdir("/tmp/r2-migrate", { recursive: true });

  for (const date of dates) {
    for (const ext of [".html", ".json"] as const) {
      const key = `${date}${ext}`;
      const path = `/tmp/r2-migrate/${key}`;
      const { code, stdout, stderr } = await runBuf("npx", [
        "wrangler",
        "kv",
        "key",
        "get",
        key,
        "--namespace-id",
        KV_NAMESPACE_ID,
        "--remote",
      ]);
      if (code !== 0) {
        console.warn(`skip ${key}: ${stderr}`);
        continue;
      }
      await writeFile(path, stdout);
      const ct =
        ext === ".html"
          ? "text/html; charset=utf-8"
          : "application/json; charset=utf-8";
      await wranglerOk([
        "r2",
        "object",
        "put",
        `${R2_NEWSLETTER_BUCKET}/${key}`,
        "--file",
        path,
        "--remote",
        "--content-type",
        ct,
      ]);
      console.log(`uploaded ${key}`);
    }
  }

  const indexPath = `/tmp/r2-migrate/${ISSUES_INDEX_KEY}`;
  await writeFile(indexPath, JSON.stringify({ dates }), "utf8");
  await wranglerOk([
    "r2",
    "object",
    "put",
    `${R2_NEWSLETTER_BUCKET}/${ISSUES_INDEX_KEY}`,
    "--file",
    indexPath,
    "--remote",
    "--content-type",
    "application/json; charset=utf-8",
  ]);
  console.log(`\nDone. Wrote ${ISSUES_INDEX_KEY} with ${dates.length} issues.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
