// Unit tests for the MCP tool-name classifier used by the risk gate to
// extend production/destructive-action gating beyond Bash/Write/Edit to any
// mcp__<server>__<operation> tool call.

import test from 'node:test';
import assert from 'node:assert/strict';

import { isMcpToolName, parseMcpToolName, classifyMcpTool } from '../../scripts/security/mcp-classifier.mjs';

test('isMcpToolName recognizes only the mcp__ prefix', () => {
  assert.equal(isMcpToolName('mcp__github__merge_pull_request'), true);
  assert.equal(isMcpToolName('Bash'), false);
  assert.equal(isMcpToolName('Write'), false);
  assert.equal(isMcpToolName(''), false);
  assert.equal(isMcpToolName(undefined), false);
});

test('parseMcpToolName splits server and operation, tolerating single underscores in the server name', () => {
  assert.deepEqual(parseMcpToolName('mcp__playwright__browser_navigate'), { server: 'playwright', operation: 'browser_navigate' });
  assert.deepEqual(parseMcpToolName('mcp__claude_ai_Booking_com__accommodations_search'), { server: 'claude_ai_Booking_com', operation: 'accommodations_search' });
  assert.equal(parseMcpToolName('not-mcp-shaped'), null);
  assert.equal(parseMcpToolName('mcp__onlyserver'), null);
});

// --- unknown-tool fixtures: never automatically trusted, gated for every operation ---
test('classifyMcpTool: a completely unknown server is gated even for a read-shaped operation', () => {
  const result = classifyMcpTool('mcp__totally_unknown_service__get_status');
  assert.ok(result, 'unknown server must never pass through silently');
  assert.equal(result.className, 'other');
});

test('classifyMcpTool: a malformed tool name shape is gated, not trusted', () => {
  const result = classifyMcpTool('mcp__nodoubledunderscore');
  assert.ok(result);
  assert.equal(result.className, 'other');
});

// --- benign / read-only fixtures: known, non-write-shaped operations pass through ---
test('classifyMcpTool: known read-oriented catalog server with no write class configured passes through', () => {
  // context7-mcp / playwright-mcp are catalogued but carry no writeClass rule.
  assert.equal(classifyMcpTool('mcp__context7__query-docs'), null);
  assert.equal(classifyMcpTool('mcp__playwright__browser_snapshot'), null);
});

test('classifyMcpTool: a known write-capable server with a read-shaped operation passes through', () => {
  assert.equal(classifyMcpTool('mcp__github__get_pull_request'), null);
  assert.equal(classifyMcpTool('mcp__github__list_issues'), null);
});

// --- malicious / write fixtures: at-minimum required categories are gated ---
test('classifyMcpTool: database SQL execution is gated regardless of verb', () => {
  const result = classifyMcpTool('mcp__postgres__run_query');
  assert.ok(result);
  assert.equal(result.className, 'production-data-write');
});

test('classifyMcpTool: supabase writes and migrations are gated', () => {
  assert.equal(classifyMcpTool('mcp__supabase__update_table').className, 'production-data-write');
  assert.equal(classifyMcpTool('mcp__supabase__deploy_edge_function').className, 'production-deploy');
});

test('classifyMcpTool: GitHub merge, release, repo-setting, workflow-dispatch, and secret operations are gated distinctly', () => {
  assert.equal(classifyMcpTool('mcp__github__merge_pull_request').className, 'merge');
  assert.equal(classifyMcpTool('mcp__github__create_release').className, 'release');
  assert.equal(classifyMcpTool('mcp__github__set_secret').className, 'iam-or-secrets');
  assert.equal(classifyMcpTool('mcp__github__trigger_workflow_dispatch').className, 'repository-admin');
  assert.equal(classifyMcpTool('mcp__github__update_repository').className, 'repository-admin');
});

test('classifyMcpTool: Vercel production deploys are gated', () => {
  assert.equal(classifyMcpTool('mcp__vercel__create_deployment').className, 'production-deploy');
});

test('classifyMcpTool: Figma writes are gated', () => {
  assert.equal(classifyMcpTool('mcp__figma__create_comment').className, 'external-write');
});

test('classifyMcpTool: Sentry mutation is gated', () => {
  assert.equal(classifyMcpTool('mcp__sentry__update_issue').className, 'external-write');
});

test('classifyMcpTool: Slack/email/external-message sending is gated', () => {
  assert.equal(classifyMcpTool('mcp__slack__send_message').className, 'external-message');
  assert.equal(classifyMcpTool('mcp__sendgrid__send_email').className, 'external-message');
});

test('classifyMcpTool: cloud resource writes are gated', () => {
  assert.equal(classifyMcpTool('mcp__aws__create_bucket').className, 'production-deploy');
  assert.equal(classifyMcpTool('mcp__kubernetes__apply_manifest').className, 'production-deploy');
});

test('classifyMcpTool: IAM, RBAC, DNS, firewall, and secret changes are gated', () => {
  assert.equal(classifyMcpTool('mcp__vault__write_secret').className, 'iam-or-secrets');
});

test('classifyMcpTool: payment, refund, payout, and billing actions are gated', () => {
  assert.equal(classifyMcpTool('mcp__stripe__create_refund').className, 'payment');
});

// --- regression: independent review findings (v0.1.1 hardening) ---
test('classifyMcpTool: camelCase write operations are gated the same as snake_case (review finding: writeVerbPattern bypass)', () => {
  assert.equal(classifyMcpTool('mcp__github__mergePullRequest').className, 'merge');
  assert.equal(classifyMcpTool('mcp__github__createRelease').className, 'release');
  assert.equal(classifyMcpTool('mcp__github__setSecret').className, 'iam-or-secrets');
  assert.equal(classifyMcpTool('mcp__vercel__createDeployment').className, 'production-deploy');
  assert.equal(classifyMcpTool('mcp__stripe__createRefund').className, 'payment');
  assert.equal(classifyMcpTool('mcp__supabase__createBucket').className, 'production-data-write');
});

test('classifyMcpTool: a server name that merely contains a catalog id is not treated as known (review finding: substring-match bypass)', () => {
  // "digitalocean" contains "git" (the stripped git-cli id); "gitlab"/"gitea"
  // contain "git" too; "legitpay" contains "git". None of these are the git
  // server and must still be gated as unknown, for every operation.
  for (const toolName of [
    'mcp__digitalocean__create_droplet',
    'mcp__gitlab__delete_project',
    'mcp__gitea__delete_repo',
    'mcp__legitpay__create_charge',
  ]) {
    const result = classifyMcpTool(toolName);
    assert.ok(result, `${toolName} must be gated, not passed through`);
    assert.equal(result.className, 'other', `${toolName} must be classified as an unrecognized server`);
  }
});

test('classifyMcpTool: a bare "git" MCP server is gated for push/force/merge like Bash git (review finding: fell through with no serverActionClasses rule)', () => {
  assert.equal(classifyMcpTool('mcp__git__push_changes').className, 'git-push');
  assert.equal(classifyMcpTool('mcp__git__force_push').className, 'git-force');
  assert.equal(classifyMcpTool('mcp__git__reset_hard').className, 'git-force');
  assert.equal(classifyMcpTool('mcp__git__merge_branch').className, 'merge');
  // "git" must still be distinguished from "github" (different rule, both gated).
  assert.equal(classifyMcpTool('mcp__github__merge_pull_request').className, 'merge');
});

test('classifyMcpTool: a server name that embeds a real catalog id as a prefix/suffix is not treated as that server (review finding)', () => {
  // "context7-writer" and "playwright-deploy" are not the catalogued
  // context7/playwright servers and must not inherit their pass-through
  // (no-write-class-configured) treatment.
  const a = classifyMcpTool('mcp__context7-writer__deleteEverything');
  assert.ok(a, 'a look-alike server name must not inherit context7\'s trust');
  assert.equal(a.className, 'other');

  const b = classifyMcpTool('mcp__playwright-deploy__push_to_prod');
  assert.ok(b, 'a look-alike server name must not inherit playwright\'s trust');
  assert.equal(b.className, 'other');
});

test('classifyMcpTool: a server name embedding a serverActionClasses KEYWORD (not just a catalog id) is not treated as that known category (ADR-0027 follow-up finding, HIGH)', () => {
  // Two independent review rounds of the ADR-0027 checkpoint reproduced the
  // same live bypass: findServerRule() matched policies/mcp-policy.json's
  // serverActionClasses patterns ("github", "aws|gcp|azure|...|cloud",
  // "slack|sendgrid|twilio|mailgun|...|email", "postgres|mysql|...|sql",
  // "vault|iam|rbac|...") unanchored, so an attacker-chosen server name
  // merely CONTAINING one of these generic keywords was treated as the
  // known, reviewed server -- isKnown became true, hardDeny never applied,
  // and (since MCP write classes are now ask-eligible) the model would see
  // permissionDecision: "ask" with a reason misattributing an entirely
  // unreviewed server to GitHub/a cloud provider/etc. `className: 'other'`
  // (hardDeny) is required here, exactly like the catalog-id substring
  // bypass above -- an embedded generic keyword must not confer trust
  // either.
  const spoofs = [
    'mcp__evil-github-proxy__delete_repo',
    'mcp__mycloudthing__create_instance',
    'mcp__attacker-email-relay__send_blast',
    'mcp__my-sql-helper__execute_statement',
    'mcp__vaultish__write_secret',
    'mcp__notgithub__create_release',
  ];
  for (const toolName of spoofs) {
    const result = classifyMcpTool(toolName);
    assert.ok(result, `${toolName} must be gated, not passed through`);
    assert.equal(result.className, 'other', `${toolName} must be classified as an unrecognized server, not borrow a known category`);
    assert.equal(result.hardDeny, true, `${toolName} must be hardDeny (never ask-eligible)`);
  }
  // Sanity: the genuine, exact server names must still be recognized (this
  // fix must not turn every known server into "unknown" too).
  assert.equal(classifyMcpTool('mcp__github__merge_pull_request').className, 'merge');
  assert.equal(classifyMcpTool('mcp__stripe__create_refund').className, 'payment');
});

// --- approved-write fixture: classification is deterministic (approval flow is exercised at the hook level) ---
test('classifyMcpTool: classification is stable across repeated calls for the same write operation', () => {
  const a = classifyMcpTool('mcp__github__merge_pull_request');
  const b = classifyMcpTool('mcp__github__merge_pull_request');
  assert.deepEqual(a, b);
});
