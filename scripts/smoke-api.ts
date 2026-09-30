/** End-to-end verification against a running API. Creates a small isolated test account and room. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chooseBotShot, randomFleet } from '../src/game/engine.js';
import type { AccountState, MatchRecord, RoomView, SoloGame } from '../src/shared/contracts.js';

const base = process.env.SALVO_TEST_URL ?? 'http://localhost:3001';
let requests = 0;
class Player {
  private cookie = '';
  async request(path: string, body?: unknown, expected = 200) {
    const response = await fetch(new URL(path, base), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    requests++;
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const data = await response.json();
    assert.equal(response.status, expected, `${path}: ${JSON.stringify(data)}`);
    return data;
  }
  room(body: object) { return this.request('/api/room', body) as Promise<RoomView>; }
}

const a = new Player(); const b = new Player(); const stranger = new Player();
await a.request('/api/health');
let av = await a.room({ action: 'create', name: 'QA Alpha' });
const code = av.code;
let bv = await b.room({ action: 'join', code, name: 'QA Bravo' });
// A third player cannot inspect a board or claim a third seat.
const denied = await fetch(new URL(`/api/room?code=${code}`, base));
assert.ok(denied.status === 401 || denied.status === 403);
await stranger.request('/api/room', { action: 'join', code, name: 'QA outsider' }, 409);
const af = randomFleet(); const bf = randomFleet();
await a.request('/api/room', { action: 'place', code, fleet: [] }, 400);
av = await a.room({ action: 'place', code, fleet: af });
bv = await b.room({ action: 'place', code, fleet: bf });
av = await a.request(`/api/room?code=${code}`);
assert.equal(av.phase, 'battle'); assert.equal(av.opponentFleet, undefined); assert.equal(bv.opponentFleet, undefined);
assert.ok(!JSON.stringify(av).includes('identityId'));

// Same-cell double click must produce exactly one committed shot.
const active = av.yourTurn ? a : b;
const targetFleet = av.yourTurn ? bf : af;
const cell = targetFleet[0].cells[0];
const attempt = async () => { try { await active.room({ action: 'fire', code, cell }); return true; } catch { return false; } };
const concurrent = await Promise.all([attempt(), attempt()]);
assert.equal(concurrent.filter(Boolean).length, 1);
av = await a.request(`/api/room?code=${code}`); bv = await b.request(`/api/room?code=${code}`);
assert.equal(av.shots.length + bv.shots.length, 1);

let turns = 0;
while (av.phase !== 'finished' && bv.phase !== 'finished') {
  const isA = av.yourTurn;
  const actor = isA ? a : b;
  const view = isA ? av : bv;
  const result = await actor.room({ action: 'fire', code, cell: chooseBotShot(view.shots, 'hard') });
  if (isA) { av = result; bv = { ...bv, yourTurn: !result.yourTurn, incoming: result.shots }; }
  else { bv = result; av = { ...av, yourTurn: !result.yourTurn, incoming: result.shots }; }
  turns++;
  assert.ok(turns < 200, 'Game must finish in at most 199 total shots');
}
av = await a.request(`/api/room?code=${code}`); bv = await b.request(`/api/room?code=${code}`);
assert.equal(av.phase, 'finished'); assert.equal(bv.phase, 'finished');
assert.notEqual(av.winner, bv.winner);
assert.equal(av.opponentFleet?.length, 10); assert.equal(bv.opponentFleet?.length, 10);
await a.request('/api/room', { action: 'fire', code, cell: 0 }, 409);
console.log(`Online match verified: ${turns + 1} shots; hidden fleets, duplicate protection, result, reload.`);

const username = `qa_${randomBytes(6).toString('hex')}`;
const password = randomBytes(20).toString('base64url');
const registered = await a.request('/api/account', { action: 'register', username, password, displayName: 'QA account' }) as AccountState;
assert.equal(registered.user?.username, username);
const record: MatchRecord = {
  id: `room-${code}`, mode: 'friend', outcome: av.winner === 'you' ? 'win' : 'loss',
  shots: av.shots.length, hits: av.shots.filter(s => s.result !== 'miss').length,
  durationMs: (av.finishedAt ?? Date.now()) - av.createdAt, finishedAt: av.finishedAt ?? Date.now(), shotHistory: av.shots,
};
const savedGame: SoloGame = { id: `qa-solo-${Date.now()}`, difficulty: 'hard', phase: 'battle', playerFleet: af, botFleet: bf,
  playerShots: [], botShots: [], turn: 'player', winner: null, startedAt: Date.now() };
await a.request('/api/account', { action: 'sync', history: [record], savedGame, proDemo: true });
const otherDevice = new Player();
await otherDevice.request('/api/account', { action: 'login', username, password: 'wrong-password' }, 401);
const signedIn = await otherDevice.request('/api/account', { action: 'login', username, password }) as AccountState;
assert.equal(signedIn.history[0]?.id, record.id); assert.equal(signedIn.savedGame?.id, savedGame.id); assert.equal(signedIn.proDemo, true);
const refreshed = await otherDevice.request('/api/account') as AccountState;
assert.equal(refreshed.user?.id, registered.user?.id);
await otherDevice.request('/api/account', { action: 'logout' });
const afterLogout = await otherDevice.request('/api/account') as AccountState;
assert.equal(afterLogout.user, null);
console.log(`Cloud account verified: password auth, separate-device history/save/Pro, logout. ${requests} API requests passed.`);
