// Copies the ClickHouse password from the clipboard into .env (CLICKHOUSE_PASSWORD)
// without ever printing it. Usage: copy the password, then `npm run ch:password`.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
const cmd =
  process.platform === "win32"
    ? 'powershell -NoProfile -Command "Get-Clipboard -Raw"'
    : process.platform === "darwin"
      ? "pbpaste"
      : "xclip -selection clipboard -o";
const pw = execSync(cmd, { encoding: "utf8" }).trim();
if (!pw || /\s/.test(pw)) {
  console.error("Clipboard is empty or doesn't look like a password. Copy it and retry.");
  process.exit(1);
}
let env = readFileSync(envPath, "utf8");
env = /^CLICKHOUSE_PASSWORD=.*$/m.test(env)
  ? env.replace(/^CLICKHOUSE_PASSWORD=.*$/m, `CLICKHOUSE_PASSWORD=${pw}`)
  : `${env.trimEnd()}\nCLICKHOUSE_PASSWORD=${pw}\n`;
writeFileSync(envPath, env);

// Verify the connection without echoing the secret.
const url = /^CLICKHOUSE_URL=(.*)$/m.exec(env)?.[1]?.trim();
const user = /^CLICKHOUSE_USER=(.*)$/m.exec(env)?.[1]?.trim() || "default";
if (!url) {
  console.log("Saved password. CLICKHOUSE_URL is not set yet.");
  process.exit(0);
}
const res = await fetch(`${url}/?query=${encodeURIComponent("SELECT count() FROM system.tables WHERE database IN ('default','safetynet')")}`, {
  headers: { Authorization: `Basic ${Buffer.from(`${user}:${pw}`).toString("base64")}` },
}).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
console.log(res.ok ? `✅ ClickHouse connected — ${(await res.text()).trim()} tables visible.` : `❌ ClickHouse rejected the login (${res.status}).`);
