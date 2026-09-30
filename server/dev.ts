import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { createApiHandler, type Endpoint } from './handler.js';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const port = Number(process.env.API_PORT ?? 3001);
const handlers = {
  account: createApiHandler('account'),
  room: createApiHandler('room'),
  health: createApiHandler('health'),
};
const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  const endpoint = path.replace(/^\/api\//, '') as Endpoint;
  if (!path.startsWith('/api/') || !Object.hasOwn(handlers, endpoint)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }
  await handlers[endpoint](req, res);
});
server.listen(port, '127.0.0.1', () => {
  console.log(`SALVO API listening on http://127.0.0.1:${port}`);
  if (!process.env.DATABASE_URL)
    console.log(
      process.env.SALVO_LOCAL_MEMORY === '1'
        ? 'Explicit local memory mode: data is lost on restart.'
        : 'DATABASE_URL is missing: online endpoints return 503.',
    );
});
