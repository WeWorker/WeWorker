import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

export async function loadDecisionApiKey({ env = process.env, defaultKey, optional = false, file = join(homedir(), '.webcli/credentials/decision-api-key.dpapi') } = {}) {
  let key = env.DECISION_API_KEY?.trim() || defaultKey?.trim();
  if (!key && process.platform === 'win32' && existsSync(file)) {
    const script = [
      'Add-Type -AssemblyName System.Security',
      '$blob=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
      '$bytes=[Security.Cryptography.ProtectedData]::Unprotect($blob,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
      '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))',
    ].join(';');
    try {
      const encrypted = readFileSync(file, 'utf8');
      key = await new Promise((resolve, reject) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
          windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], timeout: 10000,
        });
        const chunks = [];
        child.stdout.on('data', chunk => chunks.push(chunk));
        child.on('error', reject);
        child.stdin.on('error', reject);
        child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks).toString('utf8').trim()) : reject(new Error()));
        child.stdin.end(encrypted);
      });
    } catch { throw new Error('Unable to decrypt the protected decision credential. Set DECISION_API_KEY.'); }
  }
  if (!key && optional) return undefined;
  if (!key || /\s/.test(key)) throw new Error('Set DECISION_API_KEY using protected configuration.');
  env.DECISION_API_KEY = key;
  return key;
}
