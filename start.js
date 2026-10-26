import { spawn } from "node:child_process";

const isRenderRuntime =
  /^(1|true|yes|on)$/i.test(String(process.env.RENDER || "")) ||
  Boolean(String(process.env.RENDER_SERVICE_ID || "").trim());

// Keep Render's memory limit isolated from the Windows/local server launch.
const nodeArgs = isRenderRuntime
  ? ["--max-old-space-size=96", "--max-semi-space-size=1", "--initial-old-space-size=16", "--expose-gc", "server.js"]
  : ["--max-old-space-size=320", "server.js"];

const child = spawn(process.execPath, nodeArgs, {
  env: process.env,
  stdio: "inherit"
});

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!stopping) {
      stopping = true;
      if (!child.killed) child.kill(signal);
    }
  });
}

child.once("error", (error) => {
  console.error("[START] Server process could not start:", error.message);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal && !stopping) process.exitCode = 1;
  else process.exitCode = Number.isInteger(code) ? code : 1;
});
