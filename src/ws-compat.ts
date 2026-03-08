/**
 * WebSocket wrapper using native WebSocket on all platforms.
 * Auth is handled via short-lived tickets obtained from the Sprites API
 * (SpriteManager.getWsTicket()) and passed as a query parameter.
 * Provides an EventEmitter-style API (.on/.removeListener) to match
 * the Node `ws` interface used throughout the codebase.
 */

export interface CompatWebSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  on(event: string, handler: (...args: any[]) => void): void;
  removeListener(event: string, handler: (...args: any[]) => void): void;
  removeAllListeners(): void;
}

export const WS_OPEN = 1;

export function createAuthWebSocket(url: string, ticket: string): CompatWebSocket {
  const sep = url.includes("?") ? "&" : "?";
  return new NativeWsAdapter(
    new WebSocket(`${url}${sep}ticket=${encodeURIComponent(ticket)}`)
  );
}

/** Adapts browser/Electron native WebSocket to EventEmitter-style API. */
class NativeWsAdapter implements CompatWebSocket {
  private handlers = new Map<string, Set<(...args: any[]) => void>>();

  constructor(private ws: WebSocket) {
    ws.onopen = () => this.emit("open");
    ws.onmessage = (e) => this.emit("message", e.data);
    ws.onclose = (e) => this.emit("close", e.code, e.reason);
    ws.onerror = () => this.emit("error", new Error("WebSocket error"));
  }

  get readyState(): number {
    return this.ws.readyState;
  }

  send(data: string): void {
    this.ws.send(data);
  }

  close(): void {
    this.ws.close();
  }

  on(event: string, handler: (...args: any[]) => void): void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
  }

  removeListener(event: string, handler: (...args: any[]) => void): void {
    this.handlers.get(event)?.delete(handler);
  }

  removeAllListeners(): void {
    this.handlers.clear();
    this.ws.onopen = null;
    this.ws.onmessage = null;
    this.ws.onclose = null;
    this.ws.onerror = null;
  }

  private emit(event: string, ...args: any[]): void {
    this.handlers.get(event)?.forEach((h) => h(...args));
  }
}
