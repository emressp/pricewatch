import { createApp } from './app.js';
import { buildContext } from './bootstrap.js';
import { catchUpDueMonitors, checkDueMonitors } from './checker.js';
import { loadEnvFile, serverRoot } from './config.js';

loadEnvFile(serverRoot());
const ctx = await buildContext();

if (ctx.config.nodeEnv === 'production' && !ctx.config.sessionSecret) {
  console.error('SESSION_SECRET is required in production.');
  process.exit(1);
}

const app = createApp(ctx);
const server = app.listen(ctx.config.port, () => {
  const base = ctx.config.appBaseUrl;
  console.log(`Pricewatch monitor listening on ${base}`);
  console.log(`  App:    ${base}/app`);
  console.log(`  Sample: ${base}/demo/page`);
  console.log(`  Plans:  ${base}/monitor/`);
});

let timer = null;
let checkerRunning = false;
if (ctx.config.checkerEnabled) {
  const seconds = Math.max(15, ctx.config.checkIntervalSeconds || 60);
  console.log(`  Checker every ${seconds}s in this process`);
  const tick = () => {
    if (checkerRunning) return;
    checkerRunning = true;
    checkDueMonitors(ctx).catch((err) => console.error('[checker]', err)).finally(() => {
      checkerRunning = false;
    });
  };
  timer = setInterval(tick, seconds * 1000);
  setTimeout(() => {
    catchUpDueMonitors(ctx).catch((err) => console.error('[checker]', err));
  }, 2000).unref?.();
}

function shutdown() {
  if (timer) clearInterval(timer);
  server.close(() => {
    try { ctx.db.close(); } catch { /* already closed */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
