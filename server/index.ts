import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runAudit } from './audit.ts';
import { authRoutes } from './auth.ts';
import { config } from './config.ts';
import { addTimeframeTwins, addInverseTwins, mirrorInverseHistory, nameInverseTwins, dropReplays, migratePricing, startEngine } from './engine/runner.ts';
import { loadCandles, syncCandles } from './market.ts';
import { apiRoutes } from './routes.ts';

const app = Fastify({ logger: { level: config.production ? 'info' : 'warn' } });
await app.register(cookie);
authRoutes(app);
apiRoutes(app);

const webDist = resolve('dist/web');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  // Client-side routes fall back to index.html.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
    return reply.sendFile('index.html');
  });
}

loadCandles();
console.log('[market] loading Binance BTCUSDT 1h candles...');
await syncCandles();
migratePricing();
addTimeframeTwins();
dropReplays();
addInverseTwins();
nameInverseTwins();
// Rebuild inverse histories as strict mirrors before the engine trades again. It calls Polymarket, so the
// server starts listening meanwhile.
mirrorInverseHistory()
  .catch((e) => console.error('[engine] mirror rebuild failed', e))
  .finally(() => startEngine());
// Cross-check every settled trade against Polymarket shortly after boot, then every 6 hours.
setTimeout(() => runAudit().catch((e) => console.error('[audit]', e)), 60_000);
setInterval(() => runAudit().catch((e) => console.error('[audit]', e)), 6 * 3600_000);

await app.listen({ port: config.port, host: config.host });
console.log(`[poly-bots] listening on http://localhost:${config.port}`);
