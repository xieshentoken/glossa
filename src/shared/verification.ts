// How far each built-in provider and harness preset has actually been verified.
// Shown in Settings so stand-in tests are never presented as real checks.

export type Verification = 'test-double' | 'flags-checked' | 'real' | 'unverified' | 'n/a';

export const VERIFICATION: Record<string, Verification> = {
  // Request bodies and stream handling tested against recorded/mocked HTTP only.
  anthropic: 'test-double',
  openai: 'test-double',
  ollama: 'test-double',
  demo: 'n/a',
  // Pi SDK 1.3.0 run for real with Glossa's offline demo model; no real provider yet.
  pi: 'test-double',
  codex: 'unverified',
  opencode: 'unverified',
};
