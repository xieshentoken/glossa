// Environment for agent harness processes: an allow-list instead of a copy of
// the app's environment, plus redaction of secrets in logs and dialogs.

const BASE_ALLOW = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'TERM',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
  // Network setup the CLIs need to reach their provider.
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'all_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
];
const WINDOWS_ALLOW = [
  'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE',
  'HOMEDRIVE', 'HOMEPATH', 'PROGRAMDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'PROGRAMFILES', 'NUMBER_OF_PROCESSORS',
];
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_()]{0,63}$/;
const SECRET_NAME_RE = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE/i;

export interface AgentEnvOptions {
  parent?: NodeJS.ProcessEnv;
  extraAllow?: string[];
  /** Key passed from Glossa's own store, and the variable that carries it. */
  apiKey?: string;
  keyEnv?: string;
  tmpDir: string;
  platform?: NodeJS.Platform;
}

export function buildAgentEnv(o: AgentEnvOptions): NodeJS.ProcessEnv {
  const parent = o.parent ?? process.env;
  const allow = new Set([...BASE_ALLOW, ...((o.platform ?? process.platform) === 'win32' ? WINDOWS_ALLOW : [])]);
  for (const n of o.extraAllow ?? []) if (ENV_NAME_RE.test(n)) allow.add(n);
  const env: NodeJS.ProcessEnv = {};
  for (const name of allow) if (parent[name] !== undefined) env[name] = parent[name];
  for (const k of Object.keys(parent)) if (k.startsWith('LC_')) env[k] = parent[k];
  env.TMPDIR = o.tmpDir;
  env.TEMP = o.tmpDir;
  env.TMP = o.tmpDir;
  env.TERM = 'dumb';
  env.NO_COLOR = '1';
  if (o.apiKey && o.keyEnv && ENV_NAME_RE.test(o.keyEnv)) env[o.keyEnv] = o.apiKey;
  return env;
}

/** Values that must never appear in logs: the passed key and any secret-looking variable. */
export function secretValues(env: NodeJS.ProcessEnv, extra: (string | undefined)[] = []): string[] {
  const vals = Object.entries(env)
    .filter(([k, v]) => SECRET_NAME_RE.test(k) && v && v.length >= 6)
    .map(([, v]) => v as string);
  // Proxy URLs can carry credentials (user:pass@host).
  for (const [k, v] of Object.entries(env)) {
    const m = /proxy/i.test(k) && v ? /\/\/([^@/]+)@/.exec(v) : null;
    if (m) vals.push(m[1]);
  }
  for (const e of extra) if (e && e.length >= 6) vals.push(e);
  return [...new Set(vals)].sort((a, b) => b.length - a.length);
}

export function redactor(secrets: string[]): (s: string) => string {
  if (!secrets.length) return (s) => s;
  return (s) => secrets.reduce((acc, v) => acc.split(v).join('[redacted]'), s);
}
