
const { app, BrowserWindow, dialog } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");

const PORT = Number(process.env.PARTHAVI_DESKTOP_PORT || 8787);
let serverProcess = null;
let mainWindow = null;

function serverScriptPath() {
  return path.join(__dirname, "..", "server.js");
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
        res.resume();
        if (res.statusCode && res.statusCode < 500) return resolve();
        retry();
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
      // The app can still run in demo/offline mode without an env file.
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
    FRONTEND_ORIGINS: "http://127.0.0.1:" + PORT + ",http://localhost:" + PORT
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

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#0b0f14",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => { mainWindow = null; });

  await waitForServer("http://127.0.0.1:" + PORT + "/");
  await mainWindow.loadURL("http://127.0.0.1:" + PORT + "/");
}

app.whenReady().then(async () => {
  startLocalServer();
  try {
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
  if (serverProcess && !serverProcess.killed) {
    try { serverProcess.kill(); } catch {}
  }
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (serverProcess && !serverProcess.killed) {
    try { serverProcess.kill(); } catch {}
  }
});
