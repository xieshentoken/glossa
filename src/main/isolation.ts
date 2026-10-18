// What OS-level isolation an agent run gets. Glossa does not yet wrap harnesses
// in a sandbox, so runs are reported as NOT isolated even when a sandbox tool is
// installed. A working directory is not a sandbox.

import fs from 'node:fs';
import path from 'node:path';

export interface IsolationStatus {
  isolated: boolean;
  mode: 'none';
  /** Plain-language description shown in the approval dialog and settings. */
  detail: string;
  /** Sandbox tools found on this machine (not used yet). */
  toolsFound: string[];
}

function onPath(bin: string, envPath = process.env.PATH ?? ''): string | undefined {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

export function detectIsolation(platform = process.platform, envPath = process.env.PATH): IsolationStatus {
  const candidates = platform === 'linux' ? ['bwrap', 'firejail'] : platform === 'darwin' ? ['sandbox-exec'] : [];
  const toolsFound = candidates.filter((b) => onPath(b, envPath));
  return {
    isolated: false,
    mode: 'none',
    toolsFound,
    detail:
      'No OS-level isolation: the agent runs as your user account. It starts in its own job folder, but it can read ' +
      'other files your account can read (including your home folder and its own login data) and can use the network.' +
      (toolsFound.length ? ` (${toolsFound.join(', ')} is installed but not used by Glossa yet.)` : ''),
  };
}
