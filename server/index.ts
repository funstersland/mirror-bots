import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { authRoutes } from './auth.ts';
import { config } from './config.ts';
import { addTimeframeTwins, addInverseTwins, dropReplays, migratePricing, startEngine } from './engine/runner.ts';
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
startEngine();

await app.listen({ port: config.port, host: config.host });
console.log(`[poly-bots] listening on http://localhost:${config.port}`);
