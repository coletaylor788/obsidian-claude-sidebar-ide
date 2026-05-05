export interface ShellOptions {
  workingDir?: string | null;
  yoloMode?: boolean;
  continueSession?: boolean;
  /** If set and the backend has resumeByIdFlag, resume this specific
   *  conversation instead of the cwd's most-recent. Lets each tab keep its
   *  own claude conversation across plugin reloads. */
  claudeSessionId?: string | null;
  /** This tab's plugin sessionId (UUID). Exposed to the spawned shell as
   *  CLAUDE_OBSIDIAN_TAB_ID so that the per-event hook scripts can include
   *  it in their /notify POST, letting the plugin target the bell to the
   *  exact tab that fired the event. */
  tabId?: string | null;
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
