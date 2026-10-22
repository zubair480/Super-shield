// SuperShield Patient: one command runs the dashboard server and the
// continuous monitoring worker side by side (no manual "Scan" step).
import { spawn } from "node:child_process";

const procs = [
  ["dashboard", ["run", "dashboard"]],
  ["worker", ["run", "worker"]],
].map(([name, args]) => {
  const p = spawn("npm", args, { stdio: ["ignore", "pipe", "pipe"], shell: true });
  const tag = (s) =>
    s.toString().split(/\r?\n/).filter(Boolean).forEach((l) => console.log(`[${name}] ${l}`));
  p.stdout.on("data", tag);
  p.stderr.on("data", tag);
  p.on("exit", (code) => {
    console.log(`[${name}] exited (${code})`);
    procs.forEach((o) => o.kill());
    process.exit(code ?? 0);
  });
  return p;
});

process.on("SIGINT", () => procs.forEach((p) => p.kill()));
