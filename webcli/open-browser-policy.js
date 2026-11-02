import fs from "fs";
import os from "os";
import path from "path";
import { resolveAdaptersDir } from "./paths.js";

function normalizeOrigin(raw) {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  }
  return url.origin;
}

function hostToOrigins(rawHost) {
  const host = String(rawHost || "").trim();
  if (!host) return [];
  if (/^https?:\/\//i.test(host)) return [normalizeOrigin(host)];
  if (host.includes("*")) return [];
  return [`https://${host}`, `http://${host}`].map(normalizeOrigin);
}

function loadSettingsExtraOrigins() {
  try {
    const settingsPath = path.join(os.homedir(), ".weworker", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    return Array.isArray(settings?.open_browser_allowed_origins)
      ? settings.open_browser_allowed_origins.join(",")
      : "";
  } catch {
    return "";
  }
}

export function buildAllowedOpenBrowserOrigins(
  manifests = [],
  extraCsv = [process.env.WEWORKER_ALLOWED_OPEN_BROWSER_ORIGINS || "", loadSettingsExtraOrigins()].filter(Boolean).join(","),
) {
  const origins = new Set();

  for (const manifest of manifests) {
    if (manifest?.homepage_url) {
      try { origins.add(normalizeOrigin(manifest.homepage_url)); } catch {}
    }
    for (const match of Array.isArray(manifest?.match) ? manifest.match : []) {
      for (const origin of hostToOrigins(match)) origins.add(origin);
    }
    // A site domain opens at its apex or www host; deeper pages are reached by Adapter commands.
    for (const domain of Array.isArray(manifest?.domains) ? manifest.domains : []) {
      for (const host of [domain, `www.${domain}`]) {
        for (const origin of hostToOrigins(host)) origins.add(origin);
      }
    }
  }

  for (const raw of extraCsv.split(",")) {
    const value = raw.trim();
    if (!value) continue;
    origins.add(normalizeOrigin(value));
  }

  return origins;
}

export function loadAdapterManifests(adaptersDir = resolveAdaptersDir()) {
  if (!fs.existsSync(adaptersDir)) return [];
  const manifests = [];
  for (const entry of fs.readdirSync(adaptersDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(adaptersDir, entry.name, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    try {
      manifests.push(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
    } catch {}
  }
  return manifests;
}

export function assertAllowedOpenBrowserUrl(rawUrl, allowedOrigins) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`无效的URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`不支持的URL协议 "${url.protocol}"，只允许 http/https`);
  }
  if (process.env.WEWORKER_CHAT_PERMISSION_MODE === "ask" || process.env.WEWORKER_CHAT_PERMISSION_MODE === "full") {
    return url.toString();
  }
  const origins = allowedOrigins || buildAllowedOpenBrowserOrigins(loadAdapterManifests());
  if (!origins.has(url.origin)) {
    throw new Error(`open_browser URL is not allowed: ${url.origin}`);
  }
  return url.toString();
}
