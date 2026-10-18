#!/usr/bin/env node
// Stand-in for an agent CLI (Claude Code stream-json protocol). Reads the task
// on stdin, checks the workspace layout, writes output/index.html.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const args = process.argv.slice(2);
const mode = process.env.FAKE_AGENT_MODE ?? 'ok';
let task = '';
for await (const chunk of process.stdin) task += chunk;
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');

const skill = /Use the ([\w-]+) skill/.exec(task)?.[1];
if (!skill || !fs.existsSync(`.claude/skills/${skill}/SKILL.md`)) {
  process.stderr.write(`skill ${skill} not found in workspace\n`);
  process.exit(3);
}
if (!fs.existsSync('context.md')) process.exit(4);
if (process.env.FAKE_AGENT_DUMP_ENV) {
  fs.writeFileSync('env.json', JSON.stringify(process.env));
  // Echo a passed key on stderr, to check the log is redacted.
  if (process.env.ANTHROPIC_API_KEY) process.stderr.write(`using key ${process.env.ANTHROPIC_API_KEY}\n`);
}

say({ type: 'system', subtype: 'init', model: args[args.indexOf('--model') + 1] ?? 'unknown' });
say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'node build.mjs' } }] } });
if (mode === 'hang') {
  // A grandchild too, to check cancel stops the whole process group.
  const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  fs.writeFileSync('pids.json', JSON.stringify([process.pid, grandchild.pid]));
  await new Promise((r) => setTimeout(r, 60_000));
}
if (mode === 'fail') {
  say({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'it broke' });
  process.exit(1);
}
const term = /explain the term "([^"]+)"/.exec(task)?.[1] ?? '?';
fs.mkdirSync('output', { recursive: true });
fs.writeFileSync(
  'output/index.html',
  `<!doctype html><html><body><h1 id="t">${term}</h1><script>document.body.dataset.ran='1'</script></body></html>`,
);
say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: `${process.cwd()}/output/index.html` } }] } });
say({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0.0123 });
