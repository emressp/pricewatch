import express from 'express';
import { CHANGED_DEMO_HTML, DEFAULT_DEMO_HTML } from './demo-page.js';
import { createRouter, safeNext } from './routes.js';
import { page } from './templates.js';

export function createApp(ctx) {
  const app = express();
  app.disable('x-powered-by');
  if (ctx.config.trustProxy) app.set('trust proxy', 1);
  const demo = { html: DEFAULT_DEMO_HTML };

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const origin = req.headers.origin;
    if (!origin) return next();
    let host = '';
    try { host = new URL(origin).host; } catch { return res.status(403).type('text').send('Bad origin'); }
    if (host !== req.headers.host) return res.status(403).type('text').send('Bad origin');
    return next();
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/demo/page', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(demo.html);
  });

  app.post('/demo/page', express.text({ type: '*/*', limit: '500kb' }), (req, res) => {
    if (!ctx.config.demoEnabled) return res.status(404).type('text').send('Not found');
    if (typeof req.body !== 'string' || !req.body.includes('<')) {
      return res.status(400).json({ error: 'Send an HTML body' });
    }
    demo.html = req.body;
    res.json({ ok: true });
  });

  app.post('/demo/variant', express.urlencoded({ extended: false }), (req, res) => {
    if (!ctx.config.demoEnabled) return res.status(404).type('text').send('Not found');
    demo.html = req.body?.variant === 'original' ? DEFAULT_DEMO_HTML : CHANGED_DEMO_HTML;
    res.redirect(303, safeNext(req.body?.next));
  });

  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use('/app', createRouter(ctx));

  app.use((req, res, next) => {
    const path = decodeURIComponent(req.path).toLowerCase();
    if (
      path === '/server' || path.startsWith('/server/') ||
      path.startsWith('/.git') ||
      path.includes('.env') ||
      path.startsWith('/node_modules')
    ) {
      return res.status(404).type('text').send('Not found');
    }
    return next();
  });
  app.use(express.static(ctx.config.staticRoot, { extensions: ['html'], index: 'index.html' }));

  app.use((req, res) => {
    res.status(404).type('html').send(page({
      title: 'Not found',
      width: 640,
      body: '<div class="card"><h1>Page not found</h1><p><a href="/">Back to Pricewatch</a></p></div>',
    }));
  });

  app.use((err, _req, res, _next) => {
    console.error(err);
    if (res.headersSent) return;
    res.status(500).type('html').send(page({
      title: 'Something went wrong',
      width: 640,
      body: '<div class="card"><h1>Something went wrong</h1><p>Try that again in a moment.</p></div>',
    }));
  });

  return app;
}
