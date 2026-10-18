// Permission and navigation policy for sessions that show remote web pages
// (the reader's <webview> partition) and for the app's own session.

export const WEB_PARTITION = 'persist:web';

/** Permissions a remote page may get. The reader needs none. */
export const ALLOWED_WEB_PERMISSIONS = new Set<string>([]);

export interface SessionLike {
  setPermissionRequestHandler(h: ((wc: unknown, permission: string, cb: (ok: boolean) => void, details?: unknown) => void) | null): void;
  setPermissionCheckHandler(h: ((wc: unknown, permission: string, origin: string, details?: unknown) => boolean) | null): void;
  setDevicePermissionHandler?(h: ((details: unknown) => boolean) | null): void;
  setDisplayMediaRequestHandler?(h: ((req: unknown, cb: (streams: object) => void) => void) | null): void;
  on?(event: 'will-download', listener: (e: { preventDefault(): void }, item: { cancel(): void }) => void): unknown;
}

export function lockDownSession(ses: SessionLike, allowed = ALLOWED_WEB_PERMISSIONS): void {
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  ses.setDevicePermissionHandler?.(() => false);
  ses.setDisplayMediaRequestHandler?.((_req, cb) => cb({}));
  // Downloads would write to disk on a page's behalf; the reader does not need them.
  ses.on?.('will-download', (e, item) => {
    e.preventDefault();
    item.cancel();
  });
}

/** Only http(s) pages are loaded in the reader; everything else is refused. */
export function webNavigationAllowed(url: string): boolean {
  return /^https?:\/\//i.test(url);
}
