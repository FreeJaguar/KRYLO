#!/usr/bin/env node
// CLI wrapper over lib/redact: sanitize text before display or persistence.
// Usage: echo "text" | node redact.mjs   or   node redact.mjs --text "text"

import { redactText } from '../lib/redact.mjs';

async function main() {
  const argIndex = process.argv.indexOf('--text');
  if (argIndex !== -1 && process.argv[argIndex + 1] !== undefined) {
    process.stdout.write(redactText(process.argv[argIndex + 1]));
    return;
  }
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  process.stdout.write(redactText(data));
}

main().catch(() => process.exit(0));
