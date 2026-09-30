import { randomInt } from 'node:crypto';
import { fireAt } from '../src/game/engine.js';
import type { RoomView, Shot } from '../src/shared/contracts.js';
import type { RoomRecord, RoomState, Store } from './store.js';
import { cell, fleet, HttpError, name } from './validation.js';

const ROOM_TTL = 7 * 24 * 60 * 60 * 1000;
function playerIndex(room: RoomState, identityId: string): 0 | 1 {
  const index = room.players.findIndex(
    (player) => player?.identityId === identityId,
  );
  if (index < 0)
    throw new HttpError(
      403,
      'Эта комната открыта только её участникам. Войдите по коду приглашения.',
    );
  return index as 0 | 1;
}
/** Hit metadata never reveals the identity or remaining cells of an unsunk opponent ship. */
function publicShot(shot: Shot): Shot {
  return shot.result === 'sunk'
    ? {
        cell: shot.cell,
        result: shot.result,
        shipId: shot.shipId,
        sunkCells: shot.sunkCells ? [...shot.sunkCells] : undefined,
      }
    : { cell: shot.cell, result: shot.result };
}
export function roomView(record: RoomRecord, identityId: string): RoomView {
  const room = record.state;
  const index = playerIndex(room, identityId);
  const own = room.players[index]!;
  const opponent = room.players[index === 0 ? 1 : 0];
  return {
    code: room.code,
    phase: room.phase,
    ownFleet: structuredClone(own.fleet),
    shots: own.shots.map(publicShot),
    incoming: opponent?.shots.map(publicShot) ?? [],
    ready: own.fleet.length === 10,
    opponentReady: opponent?.fleet.length === 10,
    opponentJoined: Boolean(opponent),
    opponentName: opponent?.name ?? 'Ожидаем друга',
    yourTurn: room.phase === 'battle' && room.turn === index,
    winner:
      room.winner === null ? null : room.winner === index ? 'you' : 'opponent',
    revision: record.revision,
    createdAt: room.createdAt,
    ...(room.finishedAt !== undefined ? { finishedAt: room.finishedAt } : {}),
    ...(room.phase === 'finished' && opponent
      ? { opponentFleet: structuredClone(opponent.fleet) }
      : {}),
  };
}
export async function readRoom(
  store: Store,
  code: string,
  identityId: string,
  now: number,
): Promise<RoomView> {
  const room = await store.getRoom(code, now);
  if (!room)
    throw new HttpError(404, 'Комната не найдена или срок приглашения истёк.');
  return roomView(room, identityId);
}
export async function createRoom(
  store: Store,
  identityId: string,
  rawName: unknown,
  now: number,
): Promise<RoomView> {
  const playerName = name(rawName, 'Капитан');
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = Array.from(
      { length: 6 },
      () => alphabet[randomInt(alphabet.length)],
    ).join('');
    const room: RoomRecord = {
      state: {
        code,
        phase: 'waiting',
        players: [{ identityId, name: playerName, fleet: [], shots: [] }, null],
        turn: randomInt(2) as 0 | 1,
        winner: null,
        createdAt: now,
      },
      revision: 0,
      expiresAt: now + ROOM_TTL,
    };
    if (await store.createRoom(room)) return roomView(room, identityId);
  }
  throw new HttpError(
    503,
    'Не удалось создать приглашение. Попробуйте ещё раз.',
  );
}
async function mutateRoom(
  store: Store,
  code: string,
  identityId: string,
  now: number,
  change: (room: RoomState) => boolean,
): Promise<RoomView> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const current = await store.getRoom(code, now);
    if (!current)
      throw new HttpError(
        404,
        'Комната не найдена или срок приглашения истёк.',
      );
    const next = structuredClone(current.state);
    if (!change(next)) return roomView(current, identityId);
    if (await store.updateRoom(code, current.revision, next, now)) {
      return roomView(
        { ...current, state: next, revision: current.revision + 1 },
        identityId,
      );
    }
  }
  throw new HttpError(
    409,
    'Комната обновилась. Обновите поле и повторите действие.',
  );
}
export async function joinRoom(
  store: Store,
  code: string,
  identityId: string,
  rawName: unknown,
  now: number,
): Promise<RoomView> {
  const playerName = name(rawName, 'Друг');
  return mutateRoom(store, code, identityId, now, (room) => {
    if (room.players.some((player) => player?.identityId === identityId))
      return false;
    if (room.players[1])
      throw new HttpError(409, 'В комнате уже два игрока. Создайте новую.');
    if (room.phase !== 'waiting')
      throw new HttpError(409, 'Эта партия уже началась.');
    room.players[1] = { identityId, name: playerName, fleet: [], shots: [] };
    room.phase = 'placement';
    return true;
  });
}
export async function placeRoom(
  store: Store,
  code: string,
  identityId: string,
  rawFleet: unknown,
  now: number,
): Promise<RoomView> {
  const checkedFleet = fleet(rawFleet);
  return mutateRoom(store, code, identityId, now, (room) => {
    const index = playerIndex(room, identityId);
    if (room.phase !== 'placement' && room.phase !== 'waiting')
      throw new HttpError(409, 'Расстановка уже завершена.');
    if (room.players[index]!.fleet.length)
      throw new HttpError(409, 'Ваш флот уже готов.');
    room.players[index]!.fleet = checkedFleet;
    if (room.players.every((player) => player && player.fleet.length === 10))
      room.phase = 'battle';
    return true;
  });
}
export async function fireRoom(
  store: Store,
  code: string,
  identityId: string,
  rawCell: unknown,
  now: number,
): Promise<RoomView> {
  const targetCell = cell(rawCell);
  return mutateRoom(store, code, identityId, now, (room) => {
    const index = playerIndex(room, identityId);
    if (room.phase !== 'battle')
      throw new HttpError(
        409,
        room.phase === 'finished'
          ? 'Партия уже завершена.'
          : 'Дождитесь готовности обоих игроков.',
      );
    const own = room.players[index]!;
    const opponent = room.players[index === 0 ? 1 : 0]!;
    if (own.shots.some((shot) => shot.cell === targetCell))
      throw new HttpError(409, 'Вы уже стреляли в эту клетку.');
    if (room.turn !== index) throw new HttpError(409, 'Сейчас ход соперника.');
    try {
      const result = fireAt(opponent.fleet, own.shots, targetCell);
      own.shots = result.shots;
      if (result.finished) {
        room.phase = 'finished';
        room.winner = index;
        room.finishedAt = now;
      } else if (result.shot.result === 'miss') room.turn = index === 0 ? 1 : 0;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        400,
        'Этот выстрел не соответствует правилам партии.',
      );
    }
    return true;
  });
}
