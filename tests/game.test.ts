import { describe, expect, it } from 'vitest';
import { analyzeGame, BOARD_SIZE, canPlaceShip, chooseBotShot, coordinate, fireAt, FLEET_SIZES, randomFleet, shipCells, validateFleet } from '../src/game/engine';
import type { Difficulty, Fleet, Shot } from '../src/shared/contracts';

function seeded(seed: number): () => number {
  return () => {
    seed = Math.imul(1664525, seed) + 1013904223 | 0;
    return (seed >>> 0) / 4294967296;
  };
}

const fixture = (): Fleet => [[0, 1, 2, 3], [20, 21, 22], [40, 41, 42], [60, 61], [80, 81], [5, 15], [7], [27], [47], [67]].map((cells, index) => ({ id: `s${index}`, size: cells.length, cells }));

describe('classic fleet rules', () => {
  it('defines the classic board and generates 500 valid, diverse fleets', () => {
    expect(BOARD_SIZE).toBe(10);
    expect(FLEET_SIZES).toEqual([4, 3, 3, 2, 2, 2, 1, 1, 1, 1]);
    const arrangements = new Set<string>();
    for (let seed = 0; seed < 500; seed += 1) {
      const fleet = randomFleet(seeded(seed));
      expect(validateFleet(fleet)).toEqual({ valid: true });
      expect(new Set(fleet.flatMap((ship) => ship.cells)).size).toBe(20);
      arrangements.add(JSON.stringify(fleet.map((ship) => ship.cells)));
    }
    expect(arrangements.size).toBeGreaterThan(490);
  });

  it.each([0, 1, -2, Number.NaN, Number.POSITIVE_INFINITY])('terminates with a pathological RNG returning %s', (value) => {
    expect(validateFleet(randomFleet(() => value)).valid).toBe(true);
  });

  it('rejects horizontal wrapping, vertical overflow, malformed sizes and orientations', () => {
    expect(shipCells(7, 3, 'horizontal')).toEqual([7, 8, 9]);
    expect(shipCells(80, 2, 'vertical')).toEqual([80, 90]);
    expect(shipCells(8, 3, 'horizontal')).toBeNull();
    expect(shipCells(81, 3, 'vertical')).toBeNull();
    expect(shipCells(-1, 1, 'vertical')).toBeNull();
    expect(shipCells(1.5, 1, 'horizontal')).toBeNull();
    expect(shipCells(0, 5, 'horizontal')).toBeNull();
    expect(shipCells(0, 0, 'horizontal')).toBeNull();
    expect(shipCells(0, 2, 'diagonal' as 'horizontal')).toBeNull();
  });

  it('supports partial placement but rejects touching and diagonal contact', () => {
    const partial = [{ id: 'a', size: 2, cells: [22, 23] }];
    expect(canPlaceShip(partial, 25, 3, 'vertical')).toBe(true);
    expect(canPlaceShip(partial, 24, 1, 'horizontal')).toBe(false);
    expect(canPlaceShip(partial, 11, 1, 'horizontal')).toBe(false);
    expect(canPlaceShip(partial, 33, 1, 'horizontal')).toBe(false);
    expect(canPlaceShip(partial, 23, 3, 'horizontal')).toBe(false);
    expect(validateFleet(partial).valid).toBe(false);
    expect(canPlaceShip(fixture(), 99, 1, 'horizontal')).toBe(false);
  });

  it('rejects duplicates, malformed lines, wrong composition and corrupt input', () => {
    expect(validateFleet(fixture()).valid).toBe(true);
    const mutate = (fn: (fleet: Fleet) => void) => { const fleet = fixture(); fn(fleet); return fleet; };
    const invalidFleets: unknown[] = [
      null, {}, [], [null],
      mutate((fleet) => { fleet[9].id = fleet[0].id; }),
      mutate((fleet) => { fleet[0].cells = [0, 1, 11, 12]; }),
      mutate((fleet) => { fleet[0].cells = [8, 9, 10, 11]; }),
      mutate((fleet) => { fleet[0].cells = [0, 0, 1, 2]; }),
      mutate((fleet) => { fleet[0].cells = [0, 1, 2, 100]; }),
      mutate((fleet) => { fleet[0].cells[0] = Number.NaN; }),
      mutate((fleet) => { fleet[9].cells = [3]; }),
      mutate((fleet) => { fleet[9].cells = [14]; }),
      mutate((fleet) => { fleet[9].size = 2; fleet[9].cells = [67, 68]; }),
      mutate((fleet) => { fleet[9].id = ''; }),
    ];
    for (const fleet of invalidFleets) expect(validateFleet(fleet).valid).toBe(false);
    expect(canPlaceShip(null as unknown as Fleet, 0, 1, 'horizontal')).toBe(false);
  });
});

describe('immutable shots and victory', () => {
  it('keeps inputs untouched, sinks only on the last hit, and copies public sunk cells', () => {
    const fleet = fixture();
    const initial = fireAt(fleet, [], 0);
    const snapshot = JSON.stringify({ fleet, shots: initial.shots });
    Object.freeze(initial.shots[0]);
    Object.freeze(initial.shots);
    const second = fireAt(fleet, initial.shots, 1);
    expect(second.shot).toEqual({ cell: 1, result: 'hit', shipId: 's0' });
    expect(second.finished).toBe(false);
    expect(JSON.stringify({ fleet, shots: initial.shots })).toBe(snapshot);
    const third = fireAt(fleet, second.shots, 2);
    const fourth = fireAt(fleet, third.shots, 3);
    expect(fourth.shot).toEqual({ cell: 3, result: 'sunk', shipId: 's0', sunkCells: [0, 1, 2, 3] });
    expect(fourth.shots.map((shot) => shot.result)).toEqual(['hit', 'hit', 'hit', 'sunk']);
    fourth.shot.sunkCells![0] = 99;
    expect(fleet[0].cells).toEqual([0, 1, 2, 3]);
  });

  it('handles miss, every ship size, and victory at exactly twenty hits', () => {
    const fleet = fixture();
    let result = fireAt(fleet, [], 99);
    expect(result.shot).toEqual({ cell: 99, result: 'miss' });
    let hits = 0;
    for (const ship of fleet) {
      for (let index = 0; index < ship.cells.length; index += 1) {
        result = fireAt(fleet, result.shots, ship.cells[index]);
        hits += 1;
        expect(result.shot.result).toBe(index === ship.cells.length - 1 ? 'sunk' : 'hit');
        expect(result.finished).toBe(hits === 20);
      }
    }
    expect(result.shots).toHaveLength(21);
    expect(result.shots.filter((shot) => shot.result === 'sunk')).toHaveLength(10);
    expect(() => fireAt(fleet, result.shots, 98)).toThrow('завершена');
  });

  it('rejects repeated and out-of-bounds shots without modifying history', () => {
    const fleet = fixture();
    const { shots } = fireAt(fleet, [], 99);
    expect(() => fireAt(fleet, shots, 99)).toThrow('уже стреляли');
    for (const cell of [-1, 100, 1.5, Number.NaN]) expect(() => fireAt(fleet, shots, cell)).toThrow('внутри поля');
    expect(shots).toEqual([{ cell: 99, result: 'miss' }]);
  });

  it('rejects fabricated results, forged sunk metadata and malformed saved histories', () => {
    const fleet = fixture();
    const badHistories: unknown[] = [null, {}, [null], [{ cell: 100, result: 'miss' }], [{ cell: 0, result: 'miss' }], [{ cell: 0, result: 'sunk' }], [{ cell: 99, result: 'miss' }, { cell: 99, result: 'miss' }], [{ cell: 0, result: 'hit', shipId: 'wrong' }], [{ cell: 0, result: 'hit', sunkCells: [0] }], [{ cell: 7, result: 'sunk', sunkCells: [8] }], [{ cell: 7, result: 'sunk', sunkCells: '7' }]];
    for (const shots of badHistories) expect(() => fireAt(fleet, shots as Shot[], 98)).toThrow();
    expect(() => fireAt(null as unknown as Fleet, [], 0)).toThrow();
    expect(fireAt(fleet, [{ cell: 7, result: 'sunk' }], 99).shot.result).toBe('miss');
  });
});

describe('fair bot using public shot history only', () => {
  it.each(['easy', 'medium', 'hard'] as Difficulty[])('%s never fires around a known sunken ship', (difficulty) => {
    const shots: Shot[] = [{ cell: 44, result: 'hit', shipId: 's' }, { cell: 45, result: 'sunk', shipId: 's', sunkCells: [44, 45] }];
    const excluded = [33, 34, 35, 36, 43, 44, 45, 46, 53, 54, 55, 56];
    for (let seed = 0; seed < 200; seed += 1) expect(excluded).not.toContain(chooseBotShot(shots, difficulty, seeded(seed)));
  });

  it.each(['medium', 'hard'] as Difficulty[])('%s finishes in the known direction, including board edges', (difficulty) => {
    const shots: Shot[] = [{ cell: 54, result: 'hit' }, { cell: 55, result: 'hit' }];
    for (let seed = 0; seed < 20; seed += 1) expect([53, 56]).toContain(chooseBotShot(shots, difficulty, seeded(seed)));
    expect(chooseBotShot([{ cell: 58, result: 'hit' }, { cell: 59, result: 'hit' }], difficulty, seeded(1))).toBe(57);
    expect(chooseBotShot([{ cell: 80, result: 'hit' }, { cell: 90, result: 'hit' }], difficulty, seeded(2))).toBe(70);
  });

  it('hard targets the only remaining one-cell ship on the other checkerboard color', () => {
    const fleet = fixture();
    const lastCell = fleet[fleet.length - 1].cells[0];
    let shots: Shot[] = [];
    for (let cell = 0; cell < 100; cell += 1) if (cell !== lastCell) shots = fireAt(fleet, shots, cell).shots;
    expect(chooseBotShot(shots, 'hard', seeded(8))).toBe(lastCell);
    expect(fireAt(fleet, shots, lastCell).finished).toBe(true);
  });

  it.each(['easy', 'medium', 'hard'] as Difficulty[])('%s finishes 50 full games without repeating a cell', (difficulty) => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const fleet = randomFleet(seeded(seed));
      const rng = seeded(seed + 1000);
      let shots: Shot[] = [];
      let finished = false;
      while (!finished && shots.length < 100) {
        const cell = chooseBotShot(shots, difficulty, rng);
        expect(shots.some((shot) => shot.cell === cell)).toBe(false);
        const result = fireAt(fleet, shots, cell);
        shots = result.shots;
        finished = result.finished;
      }
      expect(finished).toBe(true);
      expect(shots.filter((shot) => shot.result !== 'miss')).toHaveLength(20);
      expect(shots.filter((shot) => shot.result === 'sunk')).toHaveLength(10);
    }
  });

  it('hard uses fewer shots than easy over a fixed benchmark of 40 fleets', () => {
    const totals = { easy: 0, hard: 0 };
    for (let seed = 1; seed <= 40; seed += 1) {
      const fleet = randomFleet(seeded(seed + 2000));
      for (const difficulty of ['easy', 'hard'] as const) {
        const rng = seeded(seed + 3000);
        let shots: Shot[] = [];
        let finished = false;
        while (!finished) {
          const result = fireAt(fleet, shots, chooseBotShot(shots, difficulty, rng));
          shots = result.shots;
          finished = result.finished;
        }
        totals[difficulty] += shots.length;
      }
    }
    expect(totals.hard).toBeLessThan(totals.easy * 0.9);
  });

  it('handles damaged saved observations and rejects an exhausted board', () => {
    const corrupt = [null, { cell: 0, result: 'nonsense' }, { cell: 2, result: 'sunk', sunkCells: 'bad' }, { cell: 200, result: 'hit' }, { cell: 4, result: 'hit', sunkCells: [0, 1000] }] as unknown as Shot[];
    for (const difficulty of ['easy', 'medium', 'hard'] as Difficulty[]) {
      const cell = chooseBotShot(corrupt, difficulty, () => Number.NaN);
      expect(cell).toBeGreaterThanOrEqual(0);
      expect(cell).toBeLessThan(100);
      expect([0, 2, 4]).not.toContain(cell);
      expect(chooseBotShot(null as unknown as Shot[], difficulty)).toBeGreaterThanOrEqual(0);
      expect(() => chooseBotShot(Array.from({ length: 100 }, (_, n) => ({ cell: n, result: 'miss' })), difficulty)).toThrow('больше нет клеток');
    }
  });
});

describe('honest rules-based coach and coordinates', () => {
  it('computes accuracy and flags only information available before each move', () => {
    const shots: Shot[] = [{ cell: 44, result: 'sunk', sunkCells: [44] }, { cell: 45, result: 'miss' }, { cell: 99, result: 'miss' }];
    const report = analyzeGame(shots, 30000);
    expect(report.accuracy).toBe(33);
    expect(report.wastedShots).toBe(1);
    expect(report.tips).toHaveLength(4);
    expect(report.tips.join(' ')).toContain('10 сек.');
    expect(analyzeGame([...shots].reverse(), 30000).wastedShots).toBe(0);
  });

  it('reports empty history and sanitizes duplicates and bad values', () => {
    expect(analyzeGame([], 0)).toMatchObject({ accuracy: 0, grade: '—', wastedShots: 0 });
    expect(analyzeGame(null as unknown as Shot[], Number.NaN).accuracy).toBe(0);
    expect(analyzeGame([{ cell: 0, result: 'hit' }, { cell: 0, result: 'hit' }], -5)).toMatchObject({ accuracy: 100, wastedShots: 1 });
  });

  it('labels cells without horizontal wrapping or accepting invalid values', () => {
    expect([0, 9, 10, 99].map(coordinate)).toEqual(['A1', 'J1', 'A2', 'J10']);
    expect(() => coordinate(100)).toThrow();
  });
});
