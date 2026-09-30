import type { CoachReport, Difficulty, FireResult, Fleet, Orientation, Ship, Shot } from '../shared/contracts';

export const BOARD_SIZE = 10;
export const FLEET_SIZES: readonly number[] = Object.freeze([4, 3, 3, 2, 2, 2, 1, 1, 1, 1]);
const CELL_COUNT = BOARD_SIZE * BOARD_SIZE;
const RESULTS = new Set(['miss', 'hit', 'sunk']);
type Random = () => number;
type Validation = { valid: boolean; error?: string };

const isCell = (cell: unknown): cell is number => typeof cell === 'number' && Number.isInteger(cell) && cell >= 0 && cell < CELL_COUNT;
const isSize = (size: unknown): size is number => typeof size === 'number' && Number.isInteger(size) && size >= 1 && size <= 4;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const invalid = (error: string): Validation => ({ valid: false, error });

function neighbors(cell: number, diagonal = true): number[] {
  const row = Math.floor(cell / BOARD_SIZE);
  const col = cell % BOARD_SIZE;
  const result: number[] = [];
  for (let dr = -1; dr <= 1; dr += 1) {
    for (let dc = -1; dc <= 1; dc += 1) {
      if ((dr === 0 && dc === 0) || (!diagonal && Math.abs(dr) + Math.abs(dc) !== 1)) continue;
      const r = row + dr;
      const c = col + dc;
      if (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE) result.push(r * BOARD_SIZE + c);
    }
  }
  return result;
}

function halo(cells: readonly number[]): number[] {
  return [...new Set(cells.flatMap((cell) => [cell, ...neighbors(cell)]))];
}

function isStraightShip(cells: unknown, size?: number): cells is number[] {
  if (!Array.isArray(cells) || !isSize(cells.length) || (size !== undefined && cells.length !== size)) return false;
  if (!cells.every(isCell) || new Set(cells).size !== cells.length) return false;
  const sorted = [...cells].sort((a, b) => a - b);
  return sorted.every((cell, index) => cell === sorted[0] + index && Math.floor(cell / BOARD_SIZE) === Math.floor(sorted[0] / BOARD_SIZE))
    || sorted.every((cell, index) => cell === sorted[0] + index * BOARD_SIZE);
}

function validatePartialFleet(fleet: unknown): Validation {
  if (!Array.isArray(fleet) || fleet.length > FLEET_SIZES.length) return invalid('Флот должен содержать не больше 10 кораблей.');
  const ids = new Set<string>();
  const occupied = new Set<number>();
  const counts = new Map<number, number>();
  for (const value of fleet) {
    if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim() || value.id.length > 200 || !isSize(value.size)) return invalid('Некорректные данные корабля.');
    if (ids.has(value.id)) return invalid('У каждого корабля должен быть свой идентификатор.');
    if (!isStraightShip(value.cells, value.size)) return invalid('Корабль должен занимать соседние клетки по прямой внутри поля.');
    const count = (counts.get(value.size) ?? 0) + 1;
    if (count > FLEET_SIZES.filter((size) => size === value.size).length) return invalid('В составе флота слишком много кораблей одного размера.');
    if (halo(value.cells).some((cell) => occupied.has(cell))) return invalid('Корабли не должны касаться, даже по диагонали.');
    ids.add(value.id);
    counts.set(value.size, count);
    value.cells.forEach((cell) => occupied.add(cell));
  }
  return { valid: true };
}

/** The complete classic fleet has ten ships and twenty occupied cells. */
export function validateFleet(fleet: unknown): Validation {
  const result = validatePartialFleet(fleet);
  if (!result.valid) return result;
  if (!Array.isArray(fleet) || fleet.length !== FLEET_SIZES.length) return invalid('Расставь все 10 кораблей: 4, 3, 3, 2, 2, 2, 1, 1, 1, 1.');
  return { valid: true };
}

export function shipCells(start: number, size: number, orientation: Orientation): number[] | null {
  if (!isCell(start) || !isSize(size) || (orientation !== 'horizontal' && orientation !== 'vertical')) return null;
  const cells = Array.from({ length: size }, (_, index) => start + index * (orientation === 'horizontal' ? 1 : BOARD_SIZE));
  if (!cells.every(isCell)) return null;
  if (orientation === 'horizontal' && Math.floor(cells[cells.length - 1] / BOARD_SIZE) !== Math.floor(start / BOARD_SIZE)) return null;
  return cells;
}

export function canPlaceShip(fleet: Fleet, start: number, size: number, orientation: Orientation): boolean {
  if (!validatePartialFleet(fleet).valid) return false;
  const cells = shipCells(start, size, orientation);
  if (!cells || fleet.length >= FLEET_SIZES.length || fleet.filter((ship) => ship.size === size).length >= FLEET_SIZES.filter((value) => value === size).length) return false;
  const occupied = new Set(fleet.flatMap((ship) => ship.cells));
  return !halo(cells).some((cell) => occupied.has(cell));
}

function randomUnit(rng: Random): number {
  // A supplied RNG cannot create an out-of-bounds selection or an endless retry.
  try {
    const value = rng();
    return Number.isFinite(value) ? Math.max(0, Math.min(1 - Number.EPSILON, value)) : 0.5;
  } catch {
    return 0.5;
  }
}

function pick<T>(values: readonly T[], rng: Random): T {
  return values[Math.floor(randomUnit(rng) * values.length)];
}

function shuffle<T>(values: readonly T[], rng: Random): T[] {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(randomUnit(rng) * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

interface Placement { cells: number[]; halo: number[] }
const PLACEMENTS = new Map<number, Placement[]>();
for (const size of new Set(FLEET_SIZES)) {
  const list: Placement[] = [];
  for (let start = 0; start < CELL_COUNT; start += 1) {
    for (const orientation of (size === 1 ? ['horizontal'] : ['horizontal', 'vertical']) as Orientation[]) {
      const cells = shipCells(start, size, orientation);
      if (cells) list.push({ cells, halo: halo(cells) });
    }
  }
  PLACEMENTS.set(size, list);
}

/** Randomized backtracking also terminates for constant or malformed RNGs. */
export function randomFleet(rng: Random = Math.random): Fleet {
  const blocked = new Uint8Array(CELL_COUNT);
  const fleet: Fleet = [];
  const candidates = new Map([...PLACEMENTS].map(([size, list]) => [size, shuffle(list, rng)]));
  const place = (index: number): boolean => {
    if (index === FLEET_SIZES.length) return true;
    const size = FLEET_SIZES[index];
    for (const candidate of candidates.get(size) ?? []) {
      if (candidate.cells.some((cell) => blocked[cell] > 0)) continue;
      fleet.push({ id: `ship-${index + 1}`, size, cells: [...candidate.cells] });
      candidate.halo.forEach((cell) => { blocked[cell] += 1; });
      if (place(index + 1)) return true;
      candidate.halo.forEach((cell) => { blocked[cell] -= 1; });
      fleet.pop();
    }
    return false;
  };
  if (!place(0)) throw new Error('Не удалось расставить флот.');
  return fleet;
}

function fleetLookup(fleet: Fleet): Map<number, Ship> {
  const lookup = new Map<number, Ship>();
  for (const ship of fleet) for (const cell of ship.cells) lookup.set(cell, ship);
  return lookup;
}

function shotFor(cell: number, ship: Ship | undefined, taken: Set<number>): Shot {
  if (!ship) return { cell, result: 'miss' };
  if (ship.cells.every((part) => part === cell || taken.has(part))) return { cell, result: 'sunk', shipId: ship.id, sunkCells: [...ship.cells] };
  return { cell, result: 'hit', shipId: ship.id };
}

function sameCells(a: number[], b: number[]): boolean {
  return a.length === b.length && new Set(a).size === a.length && a.every((cell) => b.includes(cell));
}

/** Replays public results against the fleet, instead of trusting saved hit counts. */
function validateHistory(shots: unknown, lookup: Map<number, Ship>): { taken: Set<number>; hits: number } {
  if (!Array.isArray(shots) || shots.length > CELL_COUNT) throw new Error('История выстрелов повреждена.');
  const taken = new Set<number>();
  let hits = 0;
  for (const value of shots) {
    if (!isRecord(value) || !isCell(value.cell) || !RESULTS.has(value.result as string) || taken.has(value.cell) || hits === 20) throw new Error('История выстрелов повреждена.');
    const expected = shotFor(value.cell, lookup.get(value.cell), taken);
    if (value.result !== expected.result || (value.shipId !== undefined && value.shipId !== expected.shipId)) throw new Error('Результат выстрела не совпадает с флотом.');
    if (value.sunkCells !== undefined && (!Array.isArray(value.sunkCells) || !expected.sunkCells || !sameCells(value.sunkCells, expected.sunkCells))) throw new Error('Некорректные данные потопленного корабля.');
    taken.add(value.cell);
    if (expected.result !== 'miss') hits += 1;
  }
  return { taken, hits };
}

/** Pure transition; a sunk result is attached only to the final hit on a ship. */
export function fireAt(fleet: Fleet, shots: Shot[], cell: number): FireResult {
  const validation = validateFleet(fleet);
  if (!validation.valid) throw new Error(validation.error);
  if (!isCell(cell)) throw new Error('Выбери клетку внутри поля.');
  const lookup = fleetLookup(fleet);
  const { taken, hits } = validateHistory(shots, lookup);
  if (hits === 20) throw new Error('Партия уже завершена.');
  if (taken.has(cell)) throw new Error('В эту клетку уже стреляли.');
  const shot = shotFor(cell, lookup.get(cell), taken);
  return {
    shot,
    shots: [...shots.map((previous) => ({ ...previous, ...(previous.sunkCells ? { sunkCells: [...previous.sunkCells] } : {}) })), shot],
    finished: hits + (shot.result === 'miss' ? 0 : 1) === 20,
  };
}

interface Observations {
  taken: Set<number>;
  blocked: Set<number>;
  hits: Set<number>;
  remaining: number[];
}

function readableShots(input: unknown): Shot[] {
  if (!Array.isArray(input)) return [];
  return input.filter((value): value is Shot => isRecord(value) && isCell(value.cell) && RESULTS.has(value.result as string));
}

function observe(input: unknown): Observations {
  const shots = readableShots(input);
  // Preserve every already-used cell, even when a corrupt record has no result.
  const taken = new Set<number>(Array.isArray(input) ? input.filter((value) => isRecord(value) && isCell(value.cell)).map((value) => value.cell as number) : []);
  const blocked = new Set<number>(shots.filter((shot) => shot.result === 'miss').map((shot) => shot.cell));
  const sunk = new Set<number>();
  const seenShips = new Set<string>();
  const remaining = [...FLEET_SIZES];
  for (const shot of shots) {
    if (shot.result !== 'sunk') continue;
    let cells: number[];
    if (isStraightShip(shot.sunkCells) && shot.sunkCells.includes(shot.cell)) {
      cells = shot.sunkCells;
    } else {
      const identified = typeof shot.shipId === 'string'
        ? shots.filter((previous) => previous.shipId === shot.shipId && previous.result !== 'miss').map((previous) => previous.cell)
        : [shot.cell];
      cells = isStraightShip(identified) && identified.includes(shot.cell) ? identified : [shot.cell];
    }
    cells.forEach((cell) => sunk.add(cell));
    halo(cells).forEach((cell) => blocked.add(cell));
    const key = [...cells].sort((a, b) => a - b).join(',');
    if (!seenShips.has(key)) {
      const index = remaining.indexOf(cells.length);
      if (index >= 0) remaining.splice(index, 1);
      seenShips.add(key);
    }
  }
  const hits = new Set(shots.filter((shot) => shot.result === 'hit' && !sunk.has(shot.cell)).map((shot) => shot.cell));
  for (const cell of hits) {
    // A diagonal neighbor cannot belong either to this ship or another one.
    for (const adjacent of neighbors(cell)) {
      if (Math.floor(adjacent / BOARD_SIZE) !== Math.floor(cell / BOARD_SIZE) && adjacent % BOARD_SIZE !== cell % BOARD_SIZE) blocked.add(adjacent);
    }
  }
  return { taken, blocked, hits, remaining };
}

function hitClusters(hits: Set<number>): number[][] {
  const pending = new Set(hits);
  const clusters: number[][] = [];
  for (const start of hits) {
    if (!pending.delete(start)) continue;
    const cluster = [start];
    for (let index = 0; index < cluster.length; index += 1) {
      for (const cell of neighbors(cluster[index], false)) {
        if (pending.delete(cell)) cluster.push(cell);
      }
    }
    clusters.push(cluster.sort((a, b) => a - b));
  }
  return clusters.sort((a, b) => b.length - a.length);
}

function finishingCells(cluster: number[]): number[] {
  if (cluster.length === 1) return neighbors(cluster[0], false);
  if (cluster.every((cell) => Math.floor(cell / BOARD_SIZE) === Math.floor(cluster[0] / BOARD_SIZE))) {
    return [cluster[0] % BOARD_SIZE > 0 ? cluster[0] - 1 : -1, cluster[cluster.length - 1] % BOARD_SIZE < BOARD_SIZE - 1 ? cluster[cluster.length - 1] + 1 : -1].filter(isCell);
  }
  if (cluster.every((cell) => cell % BOARD_SIZE === cluster[0] % BOARD_SIZE)) return [cluster[0] - BOARD_SIZE, cluster[cluster.length - 1] + BOARD_SIZE].filter(isCell);
  return [...new Set(cluster.flatMap((cell) => neighbors(cell, false)))];
}

function densityScores(observations: Observations, focus?: number[]): Map<number, number> {
  const scores = new Map<number, number>();
  const counts = new Map<number, number>();
  for (const size of observations.remaining) counts.set(size, (counts.get(size) ?? 0) + 1);
  for (const [size, count] of counts) {
    for (const candidate of PLACEMENTS.get(size) ?? []) {
      if (candidate.cells.some((cell) => observations.blocked.has(cell))) continue;
      if (focus && !focus.every((cell) => candidate.cells.includes(cell))) continue;
      if (candidate.halo.some((cell) => observations.hits.has(cell) && !candidate.cells.includes(cell))) continue;
      const knownHits = candidate.cells.filter((cell) => observations.hits.has(cell)).length;
      const weight = count * (1 + knownHits * knownHits);
      for (const cell of candidate.cells) {
        if (!observations.taken.has(cell)) scores.set(cell, (scores.get(cell) ?? 0) + weight);
      }
    }
  }
  return scores;
}

/** All decisions use only shot results. The opponent's fleet is never an input. */
export function chooseBotShot(shots: Shot[], difficulty: Difficulty, rng: Random = Math.random): number {
  const observations = observe(shots);
  const untried = Array.from({ length: CELL_COUNT }, (_, cell) => cell).filter((cell) => !observations.taken.has(cell));
  if (!untried.length) throw new Error('На поле больше нет клеток для выстрела.');
  const legal = untried.filter((cell) => !observations.blocked.has(cell));
  const available = legal.length ? legal : untried;
  if (difficulty !== 'medium' && difficulty !== 'hard') return pick(available, rng);
  const clusters = hitClusters(observations.hits);
  if (difficulty === 'hard') {
    for (const focus of [...clusters, undefined]) {
      const scores = densityScores(observations, focus);
      const max = Math.max(0, ...available.map((cell) => scores.get(cell) ?? 0));
      if (max > 0) return pick(available.filter((cell) => scores.get(cell) === max), rng);
    }
  }
  for (const cluster of clusters) {
    const targets = finishingCells(cluster).filter((cell) => available.includes(cell));
    if (targets.length) return pick(targets, rng);
  }
  // Once only single-cell ships remain, every square is eligible again.
  if (observations.remaining.some((size) => size > 1)) {
    const parity = available.filter((cell) => (Math.floor(cell / BOARD_SIZE) + cell % BOARD_SIZE) % 2 === 0);
    if (parity.length) return pick(parity, rng);
  }
  return pick(available, rng);
}

/** A transparent rules-based coach, not a prediction of a player's ability. */
export function analyzeGame(shots: Shot[], durationMs: number): CoachReport {
  const readable = readableShots(shots);
  if (!readable.length) return { accuracy: 0, grade: '—', title: 'Разбор появится после выстрелов', tips: ['Сыграй партию: тренер разберёт точность, поиск и добивание по истории ходов.'], wastedShots: 0 };
  const history: Shot[] = [];
  const seen = new Set<number>();
  let hits = 0;
  let wastedShots = 0;
  let detours = 0;
  let streak = 0;
  let longestStreak = 0;
  for (const shot of readable) {
    const previous = observe(history);
    if (seen.has(shot.cell)) {
      wastedShots += 1;
      continue;
    }
    if (previous.blocked.has(shot.cell)) wastedShots += 1;
    if (previous.hits.size && ![...previous.hits].some((cell) => neighbors(cell, false).includes(shot.cell))) detours += 1;
    if (shot.result !== 'miss') { hits += 1; streak = 0; }
    else { streak += 1; longestStreak = Math.max(longestStreak, streak); }
    seen.add(shot.cell);
    history.push(shot);
  }
  const accuracy = Math.round(hits / seen.size * 100);
  const grade = accuracy >= 45 ? 'S' : accuracy >= 35 ? 'A' : accuracy >= 25 ? 'B' : 'C';
  const tips: string[] = [];
  if (wastedShots > 0) tips.push(`Лишних выстрелов: ${wastedShots}. Повторные клетки, диагонали от попадания и клетки вокруг потопленного корабля можно исключать сразу.`);
  else tips.push('Ты не стрелял в заведомо пустые клетки рядом с потопленными кораблями или по диагонали от попаданий. Сохраняй этот приём.');
  if (detours > 0) tips.push(`Отвлечений от добивания: ${detours}. После попадания проверь соседей по горизонтали и вертикали, а после второго — продолжай вдоль корабля.`);
  else tips.push('После попадания проверяй четыре соседние клетки. Два попадания на одной линии подскажут направление добивания.');
  if (longestStreak >= 5) tips.push(`Самая длинная серия промахов — ${longestStreak}. При поиске многопалубных кораблей используй шахматный порядок: он покрывает каждый возможный корабль длиной от двух клеток.`);
  else tips.push('Для поиска многопалубных кораблей подходит шахматный порядок. Когда останутся однопалубные, обязательно проверь клетки обоих цветов.');
  const secondsPerShot = Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs / seen.size / 1000) : 0;
  if (secondsPerShot >= 1) tips.push(`Средний темп — ${secondsPerShot} сек. на выстрел. Перед ходом проверяй отметки на поле; скорость сама по себе не делает выстрел точнее.`);
  else tips.push('Расставляя свой флот, меняй расположение кораблей от партии к партии. Это отдельный навык: по твоим выстрелам качество расстановки оценить нельзя.');
  return {
    accuracy,
    grade,
    title: seen.size < 10 ? 'Первые наблюдения' : wastedShots === 0 && accuracy >= 35 ? 'Точный поиск, экономные ходы' : detours > 3 ? 'Добивание ускорит твою игру' : 'Есть что взять в следующую партию',
    tips,
    wastedShots,
  };
}

export function coordinate(cell: number): string {
  if (!isCell(cell)) throw new Error('Клетка находится за пределами поля.');
  return `${String.fromCharCode(65 + cell % BOARD_SIZE)}${Math.floor(cell / BOARD_SIZE) + 1}`;
}
