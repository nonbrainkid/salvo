export type Difficulty = 'easy' | 'medium' | 'hard';
export type Orientation = 'horizontal' | 'vertical';
export interface Ship { id: string; size: number; cells: number[] }
export type Fleet = Ship[];
export interface Shot { cell: number; result: 'miss' | 'hit' | 'sunk'; shipId?: string; sunkCells?: number[] }
export interface FireResult { shot: Shot; shots: Shot[]; finished: boolean }
export interface SoloGame {
  id: string; difficulty: Difficulty; phase: 'battle' | 'finished';
  playerFleet: Fleet; botFleet: Fleet; playerShots: Shot[]; botShots: Shot[];
  turn: 'player' | 'bot'; winner: 'player' | 'bot' | null; startedAt: number; finishedAt?: number;
}
export interface MatchRecord {
  id: string; mode: 'solo' | 'friend'; difficulty?: Difficulty;
  outcome: 'win' | 'loss'; shots: number; hits: number; durationMs: number;
  finishedAt: number; shotHistory: Shot[];
}
export interface User { id: string; username: string; displayName: string }
export interface AccountState { user: User | null; history: MatchRecord[]; savedGame: SoloGame | null; proDemo: boolean }
export interface RoomView {
  code: string; phase: 'waiting' | 'placement' | 'battle' | 'finished';
  ownFleet: Fleet; shots: Shot[]; incoming: Shot[]; ready: boolean;
  opponentReady: boolean; opponentJoined: boolean; opponentName: string;
  yourTurn: boolean; winner: 'you' | 'opponent' | null; revision: number;
  createdAt: number; finishedAt?: number; opponentFleet?: Fleet;
}
export interface CoachReport { accuracy: number; grade: string; title: string; tips: string[]; wastedShots: number }
