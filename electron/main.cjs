const { app, BrowserWindow, dialog } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");

const PORT = Number(process.env.PARTHAVI_DESKTOP_PORT || 8787);
const BASE_URL = "http://127.0.0.1:" + PORT;
let serverProcess = null;
let mainWindow = null;
let publicWatcher = null;
let updateDebounce = null;

function serverScriptPath() {
  return path.join(__dirname, "..", "server.js");
}

function probeHealthyServer(timeoutMs = 1300) {
  return new Promise((resolve) => {
    const req = http.get(BASE_URL + "/api/health", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (body.length < 8192) body += chunk;
      });
      res.on("end", () => {
        try {
          const health = JSON.parse(body);
          resolve(res.statusCode === 200 && health.ok === true);
        } catch {
          resolve(false);
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

function waitForServer(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const retry = () => {
      if (Date.now() - started >= timeoutMs) {
        reject(new Error("Local trading server did not start within 30 seconds."));
        return;
      }
      setTimeout(probe, 350);
    };
    const probe = () => {
      const req = http.get(url, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          if (body.length < 8192) body += chunk;
        });
        res.on("end", () => {
          try {
            if (res.statusCode === 200 && JSON.parse(body).ok === true) resolve();
            else retry();
          } catch {
            retry();
          }
        });
      });
      req.on("error", retry);
      req.setTimeout(1500, () => {
        req.destroy();
        retry();
      });
    };
    probe();
  });
}

function ensureUserDataEnv() {
  const userEnv = path.join(app.getPath("userData"), ".env");
  if (!fs.existsSync(userEnv)) {
    const template = path.join(__dirname, "..", ".env.example");
    try {
      if (fs.existsSync(template)) fs.copyFileSync(template, userEnv);
    } catch {
      // Offline/demo mode remains available if a template cannot be copied.
    }
  }
  return userEnv;
}

function startLocalServer() {
  ensureUserDataEnv();
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    PORT: String(PORT),
    FRONTEND_ORIGINS: BASE_URL + ",http://localhost:" + PORT
  };

  serverProcess = spawn(process.execPath, [serverScriptPath()], {
    cwd: app.getPath("userData"),
    env,
    windowsHide: true,
    stdio: "ignore"
  });

  serverProcess.on("error", (err) => {
    dialog.showErrorBox(
      "PARTHAVI Trade Desk Pro",
      "Could not start the local server.\n\n" + err.message
    );
  });
}

async function ensureServerAvailable() {
  ensureUserDataEnv();
  // On Kiran PC, reuse the already-running server so desktop and mobile/web
  // see the same data, credentials, API and latest public UI. Never spawn a
  // duplicate process when the local server already responds.
  if (await probeHealthyServer()) return;
  startLocalServer();
  await waitForServer(BASE_URL + "/api/health");
}

function findLivePublicDirectory() {
  const configuredRoot = process.env.PARTHAVI_SERVER_ROOT;
  const candidates = [
    configuredRoot ? path.join(configuredRoot, "public") : null,
    path.join(app.getPath("home"), "ParthaviTradeDesk-Server", "public"),
    path.join(__dirname, "..", "public")
  ].filter(Boolean);
  return candidates.find((dir) => {
    try { return fs.statSync(dir).isDirectory(); } catch { return false; }
  }) || null;
}

function watchForLiveUiUpdates() {
  const publicDir = findLivePublicDirectory();
  if (!publicDir) return;

  try {
    publicWatcher = fs.watch(publicDir, { persistent: false }, (_event, filename) => {
      if (filename) {
        const name = String(filename).toLowerCase();
        if (!/\.(html|js|css|json|webmanifest|svg|png|ico)$/.test(name)) return;
      }
      if (updateDebounce) clearTimeout(updateDebounce);
      updateDebounce = setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        // Pull current files from the live Kiran PC server; this mirrors the
        // web/mobile frontend without requiring a new desktop installer for UI changes.
        mainWindow.webContents.reloadIgnoringCache();
      }, 1100);
    });
  } catch {
    publicWatcher = null;
  }
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1000,
    minHeight: 650,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#0b0f14",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    mainWindow.maximize();
  });
  mainWindow.on("closed", () => { mainWindow = null; });

  await waitForServer(BASE_URL + "/api/health");
  await mainWindow.loadURL(BASE_URL + "/");
  watchForLiveUiUpdates();
}

app.whenReady().then(async () => {
  try {
    await ensureServerAvailable();
    await createWindow();
  } catch (err) {
    dialog.showErrorBox(
      "PARTHAVI Trade Desk Pro",
      "Desktop app could not connect to its local server.\n\n" + err.message
    );
    app.quit();
  }

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      try { await createWindow(); } catch {}
    }
  });
});

app.on("window-all-closed", () => {
  if (publicWatcher) {
    try { publicWatcher.close(); } catch {}
    publicWatcher = null;
  }
  if (updateDebounce) clearTimeout(updateDebounce);
  if (serverProcess && !serverProcess.killed) {
    try { serverProcess.kill(); } catch {}
  }
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (publicWatcher) {
    try { publicWatcher.close(); } catch {}
    publicWatcher = null;
  }
  if (updateDebounce) clearTimeout(updateDebounce);
  if (serverProcess && !serverProcess.killed) {
    try { serverProcess.kill(); } catch {}
  }
});