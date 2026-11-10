import { buildContext } from './bootstrap.js';
import { checkDueMonitors } from './checker.js';
import { loadEnvFile, serverRoot } from './config.js';

loadEnvFile(serverRoot());
const ctx = await buildContext();

try {
  const results = await checkDueMonitors(ctx);
  if (!results.length) console.log('No monitors due.');
  for (const result of results) {
    const detail = result.summary || result.error || '';
    console.log(`#${result.id ?? '-'} ${result.status}${detail ? ` — ${detail}` : ''}`);
  }
} finally {
  ctx.db.close();
}
