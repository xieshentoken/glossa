#!/usr/bin/env node
// Stand-in CLI for the harness probe: --version and --help only.
const a = process.argv.slice(2);
if (a.includes('--version')) console.log('fake-cli 1.2.3');
else if (a.includes('--help')) console.log('Usage: fake-cli [options]\n  --model <m>   model\n  --effort <e>  effort\n  --max-budget-usd <n>');
