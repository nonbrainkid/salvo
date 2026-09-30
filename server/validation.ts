import { fireAt, validateFleet } from '../src/game/engine.js';
import type {
  Difficulty,
  Fleet,
  MatchRecord,
  Shot,
  SoloGame,
} from '../src/shared/contracts.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function fail(message: string): never {
  throw new HttpError(400, message);
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('Ожидался JSON-объект.');
  return value as Record<string, unknown>;
}
export function name(value: unknown, fallback?: string): string {
  if (value === undefined && fallback) return fallback;
  if (typeof value !== 'string') fail('Введите имя от 1 до 24 символов.');
  const result = value.trim();
  if (!result || result.length > 24 || /[\u0000-\u001f\u007f]/.test(result))
    fail('Введите имя от 1 до 24 символов.');
  return result;
}
export function username(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_]{3,24}$/.test(value.trim())) {
    fail('Логин: 3–24 латинские буквы, цифры или знак _.');
  }
  return value.trim().toLowerCase();
}
export function password(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128)
    fail('Пароль должен содержать от 8 до 128 символов.');
  return value;
}
export function roomCode(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Z2-9]{6}$/.test(value.trim().toUpperCase())
  )
    fail('Введите код комнаты из 6 символов.');
  return value.trim().toUpperCase();
}
function integer(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    fail(`Некорректное значение: ${label}.`);
  return value;
}
export function cell(value: unknown): number {
  return integer(value, 0, 99, 'клетка');
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(value))
    fail('Некорректный идентификатор партии.');
  return value;
}
function difficulty(value: unknown): Difficulty {
  if (value !== 'easy' && value !== 'medium' && value !== 'hard')
    fail('Некорректная сложность.');
  return value;
}
export function fleet(value: unknown): Fleet {
  if (!Array.isArray(value) || value.length !== 10)
    fail('Нужен полный флот из 10 кораблей.');
  const result = value.map((raw) => {
    const ship = object(raw);
    if (typeof ship.id !== 'string' || !ship.id || ship.id.length > 100)
      fail('Некорректный идентификатор корабля.');
    if (!Array.isArray(ship.cells) || ship.cells.length > 4)
      fail('Некорректный корабль.');
    return {
      id: ship.id,
      size: integer(ship.size, 1, 4, 'размер корабля'),
      cells: ship.cells.map(cell),
    };
  });
  const checked = validateFleet(result);
  if (!checked.valid) fail(checked.error ?? 'Неверная расстановка флота.');
  return result;
}
export function shots(value: unknown): Shot[] {
  if (!Array.isArray(value) || value.length > 100)
    fail('Некорректная история выстрелов.');
  const result: Shot[] = value.map((raw) => {
    const shot = object(raw);
    if (
      shot.result !== 'miss' &&
      shot.result !== 'hit' &&
      shot.result !== 'sunk'
    )
      fail('Некорректный результат выстрела.');
    const entry: Shot = { cell: cell(shot.cell), result: shot.result };
    if (shot.shipId !== undefined) {
      if (
        typeof shot.shipId !== 'string' ||
        !shot.shipId ||
        shot.shipId.length > 100
      )
        fail('Некорректный корабль в истории.');
      entry.shipId = shot.shipId;
    }
    if (shot.sunkCells !== undefined) {
      if (
        entry.result !== 'sunk' ||
        !Array.isArray(shot.sunkCells) ||
        !shot.sunkCells.length ||
        shot.sunkCells.length > 4
      )
        fail('Некорректный потопленный корабль.');
      entry.sunkCells = shot.sunkCells.map(cell);
      if (
        new Set(entry.sunkCells).size !== entry.sunkCells.length ||
        !entry.sunkCells.includes(entry.cell)
      )
        fail('Некорректный потопленный корабль.');
    }
    return entry;
  });
  if (new Set(result.map((shot) => shot.cell)).size !== result.length)
    fail('Выстрелы не должны повторяться.');
  return result;
}
function replay(
  fleetValue: Fleet,
  rawShots: unknown,
): { shots: Shot[]; finished: boolean } {
  const requested = shots(rawShots);
  let canonical: Shot[] = [];
  let finished = false;
  for (const shot of requested) {
    try {
      const result = fireAt(fleetValue, canonical, shot.cell);
      if (
        shot.result !== result.shot.result ||
        (shot.shipId !== undefined && shot.shipId !== result.shot.shipId)
      )
        fail('История не соответствует полю.');
      if (
        shot.sunkCells !== undefined &&
        [...shot.sunkCells].sort((a, b) => a - b).join(',') !==
          [...(result.shot.sunkCells ?? [])].sort((a, b) => a - b).join(',')
      )
        fail('История не соответствует полю.');
      canonical = result.shots;
      finished = result.finished;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      fail('История не соответствует правилам партии.');
    }
  }
  return { shots: canonical, finished };
}
export function savedGame(value: unknown, now: number): SoloGame | null {
  if (value === null) return null;
  const data = object(value);
  const playerFleet = fleet(data.playerFleet);
  const botFleet = fleet(data.botFleet);
  const player = replay(botFleet, data.playerShots);
  const bot = replay(playerFleet, data.botShots);
  if (data.phase !== 'battle' && data.phase !== 'finished')
    fail('Некорректная фаза партии.');
  if (data.turn !== 'player' && data.turn !== 'bot') fail('Некорректный ход.');
  if (data.winner !== null && data.winner !== 'player' && data.winner !== 'bot')
    fail('Некорректный победитель.');
  if (player.finished && bot.finished)
    fail('В партии не может быть двух победителей.');
  const winner = player.finished ? 'player' : bot.finished ? 'bot' : null;
  if (winner !== data.winner || (data.phase === 'finished') !== Boolean(winner))
    fail('Результат не соответствует партии.');
  const result: SoloGame = {
    id: identifier(data.id),
    difficulty: difficulty(data.difficulty),
    phase: data.phase,
    playerFleet,
    botFleet,
    playerShots: player.shots,
    botShots: bot.shots,
    turn: data.turn,
    winner,
    startedAt: integer(data.startedAt, 0, now + 300_000, 'начало партии'),
  };
  if (data.phase === 'finished')
    result.finishedAt = integer(
      data.finishedAt,
      result.startedAt,
      now + 300_000,
      'окончание партии',
    );
  return result;
}
export function history(value: unknown, now: number): MatchRecord[] {
  if (!Array.isArray(value) || value.length > 100)
    fail('История ограничена 100 партиями.');
  const records = value.map((raw) => {
    const record = object(raw);
    if (record.mode !== 'solo' && record.mode !== 'friend')
      fail('Некорректный режим игры.');
    if (record.outcome !== 'win' && record.outcome !== 'loss')
      fail('Некорректный результат партии.');
    const shotHistory = shots(record.shotHistory);
    const shotCount = integer(record.shots, 0, 100, 'число выстрелов');
    const hits = integer(
      record.hits,
      0,
      Math.min(20, shotCount),
      'число попаданий',
    );
    if (
      shotCount !== shotHistory.length ||
      hits !== shotHistory.filter((shot) => shot.result !== 'miss').length
    )
      fail('Статистика не соответствует истории выстрелов.');
    const result: MatchRecord = {
      id: identifier(record.id),
      mode: record.mode,
      outcome: record.outcome,
      shots: shotCount,
      hits,
      durationMs: integer(
        record.durationMs,
        0,
        30 * 24 * 60 * 60 * 1000,
        'длительность',
      ),
      finishedAt: integer(record.finishedAt, 0, now + 300_000, 'дата партии'),
      shotHistory,
    };
    if (record.difficulty !== undefined)
      result.difficulty = difficulty(record.difficulty);
    return result;
  });
  if (new Set(records.map((record) => record.id)).size !== records.length)
    fail('Идентификаторы партий не должны повторяться.');
  return records;
}
