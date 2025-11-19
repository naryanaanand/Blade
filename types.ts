export interface LevelData {
  themeName: string;
  instruction: string; // e.g. "Slash the VEGETABLES!"
  targets: string[]; // Items to slash
  distractors: string[]; // Items to avoid
}

export enum GameState {
  MENU = 'MENU',
  LOADING_LEVEL = 'LOADING_LEVEL',
  PLAYING = 'PLAYING',
  GAME_OVER = 'GAME_OVER',
  ERROR = 'ERROR'
}

export interface GameObject {
  id: string;
  text: string;
  x: number;
  y: number;
  vx: number; // Velocity X
  vy: number; // Velocity Y
  rotation: number; // Current rotation in radians
  vRotation: number; // Rotation speed
  isTarget: boolean;
  radius: number;
  sliced: boolean;
  color: string;
}

export interface TrailPoint {
  x: number;
  y: number;
  life: number; // For fading out (1.0 to 0.0)
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
  size: number;
}