/**
 * Path resolution for the bundled Chrome extension.
 *
 * The webcli source lives in `<repo>/webcli/`, while the extension lives in
 * `<repo>/extension/` (sibling). But when published to npm and installed
 * globally, the extension is bundled INSIDE the package as
 * `node_modules/weworker-webcli/extension/`.
 *
 * These helpers resolve the right directory for both layouts:
 *   1. sibling `../extension`          (repo dev layout)      — preferred
 *   2. package-internal `./extension`  (npm-published layout) — fallback
 */

import { existsSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the extension directory, preferring the npm-bundled copy.
 * @returns {string} Absolute path to the extension directory. Falls back to the
 *   repo-dev sibling path even when neither exists, so callers can still report
 *   a meaningful path.
 */
export function resolveExtensionDir() {
  const sibling = resolve(__dirname, "../extension");   // repo: webcli/../extension
  if (existsSync(sibling)) return sibling;
  const bundled = resolve(__dirname, "extension");      // npm: package/extension
  if (existsSync(bundled)) return bundled;
  return sibling; // default to repo layout for error messages
}

/**
 * Resolve the extension's adapters directory.
 * @returns {string} Absolute path to `<extension>/adapters`.
 */
export function resolveAdaptersDir() {
  return resolve(resolveExtensionDir(), "adapters");
}

/**
 * Resolve the user-owned adapters directory (writable, survives app updates).
 * User-installed adapters live here so they are not overwritten by packaged
 * built-in adapters. Prefers `~/.weworker/adapters` (WeWorker desktop), falls
 * back to `~/.webcli/adapters` (standalone CLI).
 * @returns {string} Absolute path to the user adapters directory.
 */
export function resolveUserAdaptersDir() {
  if (process.env.WEWORKER_USER_ADAPTERS_DIR) return resolve(process.env.WEWORKER_USER_ADAPTERS_DIR);
  const home = homedir();
  const weworker = join(home, ".weworker", "adapters");
  if (existsSync(weworker)) return weworker;
  const webcli = join(home, ".webcli", "adapters");
  if (existsSync(webcli)) return webcli;
  return weworker; // default to WeWorker layout
}
