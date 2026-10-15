import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Windows DPAPI protects this refresh token for the current Windows user.
// The vault is stored in LocalAppData, never in the repository or public assets.
function defaultVaultPath(name = "angel-refresh-token.dpapi") {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(local, "ParthaviTradeDeskPro", "secure", name);
}
function defaultFeedVaultPath() { return defaultVaultPath("angel-feed-token.dpapi"); }

function runPowerShell(script, input) {
  return execFileSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script
  ], {
    input: String(input ?? ""),
    encoding: "utf8",
    windowsHide: true,
    timeout: 8000,
    maxBuffer: 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"]
  }).trim();
}

function saveSecureRefreshToken(token, filePath = defaultVaultPath()) {
  if (process.platform !== "win32" || !String(token ?? "")) return false;
  const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security -ErrorAction Stop; $plain=[Console]::In.ReadToEnd(); if([String]::IsNullOrWhiteSpace($plain)){throw 'Empty input'}; $bytes=[System.Text.Encoding]::UTF8.GetBytes($plain); $cipher=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($cipher))";
  const encrypted = runPowerShell(script, String(token));
  if (!encrypted) throw new Error("Windows DPAPI did not return an encrypted refresh token.");
  const dir = path.dirname(filePath);
  const temporary = filePath + "." + process.pid + ".tmp";
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(temporary, encrypted, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, filePath);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
  return true;
}

function loadSecureRefreshToken(filePath = defaultVaultPath()) {
  if (process.platform !== "win32" || !existsSync(filePath)) return null;
  const encrypted = readFileSync(filePath, "utf8").trim();
  if (!encrypted) return null;
  const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security -ErrorAction Stop; $cipherText=[Console]::In.ReadToEnd().Trim(); $plain=$null; try { $protected=[Convert]::FromBase64String($cipherText); $raw=[System.Security.Cryptography.ProtectedData]::Unprotect($protected,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); $plain=[System.Text.Encoding]::UTF8.GetString($raw) } catch { $secure=ConvertTo-SecureString -String $cipherText -ErrorAction Stop; $plain=[System.Net.NetworkCredential]::new('', $secure).Password }; [Console]::Out.Write($plain)";
  const token = runPowerShell(script, encrypted);
  return token || null;
}

function deleteSecureRefreshToken(filePath = defaultVaultPath()) {
  if (process.platform !== "win32" || !existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}

function hasSecureRefreshToken(filePath = defaultVaultPath()) {
  return process.platform === "win32" && existsSync(filePath);
}
function saveSecureFeedToken(token, filePath = defaultFeedVaultPath()) { return saveSecureRefreshToken(token, filePath); }
function loadSecureFeedToken(filePath = defaultFeedVaultPath()) { return loadSecureRefreshToken(filePath); }
function deleteSecureFeedToken(filePath = defaultFeedVaultPath()) { return deleteSecureRefreshToken(filePath); }
function hasSecureFeedToken(filePath = defaultFeedVaultPath()) { return hasSecureRefreshToken(filePath); }

export { saveSecureRefreshToken, loadSecureRefreshToken, deleteSecureRefreshToken, hasSecureRefreshToken,
  saveSecureFeedToken, loadSecureFeedToken, deleteSecureFeedToken, hasSecureFeedToken };