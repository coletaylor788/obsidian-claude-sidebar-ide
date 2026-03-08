export interface ShellOptions {
  workingDir?: string | null;
  yoloMode?: boolean;
  continueSession?: boolean;
  cols?: number;
  rows?: number;
}

export interface ShellCallbacks {
  onStdout: (data: string) => void;
  onStderr: (data: string) => void;
  onExit: (code: number | null, signal: string | null) => void;
  onReconnecting?: () => void;
  onReconnected?: () => void;
}

export interface IShellManager {
  start(opts: ShellOptions, callbacks: ShellCallbacks): void;
  stop(): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  readonly isRunning: boolean;
}
