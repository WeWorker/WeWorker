import fs from 'node:fs';
import readline from 'node:readline';

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of lines) {
  const input = JSON.parse(line);
  if (input.config?.delayMs) await new Promise(resolve => setTimeout(resolve, input.config.delayMs));
  const marker = String(input.config?.crashOnceMarker || '');
  if (marker && !fs.existsSync(marker)) {
    fs.writeFileSync(marker, 'crashed once', 'utf8');
    process.exit(7);
  }
  process.stdout.write(`${JSON.stringify({
    id: input.id,
    ok: true,
    result: { text: `reply:${input.prompt}`, pid: process.pid },
  })}\n`);
}
