// Prompt templates ({{var}}) and harness command lines ({var}).

export function renderTemplate(tpl: string, vars: Record<string, string | undefined>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? '');
}

/** Split a command line into argv like a POSIX shell would, without expansion. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && (line[i + 1] === '"' || line[i + 1] === '\\')) cur += line[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (quote) throw new Error(`Unclosed ${quote} in command`);
  if (has) out.push(cur);
  return out;
}

/**
 * Turn a harness template into argv. Placeholders are substituted inside each
 * argument after splitting, so a value can never add arguments. An argument that
 * is exactly one placeholder with an empty value is dropped together with the
 * flag before it (`--model {model}` with no model → nothing).
 */
export function buildCommand(template: string, vars: Record<string, string | undefined>): string[] {
  const args = splitArgs(template);
  const out: string[] = [];
  for (const arg of args) {
    const only = /^\{(\w+)\}$/.exec(arg);
    if (only && !vars[only[1]]) {
      if (out.length > 1 && out[out.length - 1].startsWith('-')) out.pop();
      continue;
    }
    out.push(arg.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? (vars[k] ?? '') : m)));
  }
  if (!out.length) throw new Error('Empty command');
  return out;
}
