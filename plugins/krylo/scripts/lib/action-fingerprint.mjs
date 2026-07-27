// Shared fingerprint computation for scoped risk approvals.
//
// scripts/runtime/update-state.mjs uses fingerprintText() to pre-bind an
// approval to a caller-supplied --target description at request time.
// scripts/security/risk-gate.mjs uses the identical normalization when
// computing the fingerprint of the actual command it is evaluating, so the
// two can be compared for an exact match. Any difference in normalization
// between the two callers would make legitimate approvals never match, so
// this logic must not be duplicated.

import crypto from 'node:crypto';

import { redactText } from './redact.mjs';

/** Normalize + redact free text, then hash it. Never throws. */
export function fingerprintText(text) {
  const normalized = redactText(String(text ?? '').replace(/\s+/g, ' ').trim());
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}
