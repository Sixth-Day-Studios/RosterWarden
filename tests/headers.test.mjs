/**
 * The Content-Security-Policy in _headers against the app's own code: every outside host the code names is
 * either allowed by the policy or a page the app only opens as a link, so a new service (or a moved sync
 * worker) can't be blocked in the browser without a test failing here first. And the policy stays strict:
 * no inline or eval'd script, no inline styles, never framed.
 *
 *   node --test tests/headers.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Hosts the code names that the app only links to or opens in a new tab, never fetches or frames. */
const LINK_ONLY = new Set([
  'aistudio.google.com', 'console.anthropic.com', 'platform.openai.com',   // where to get an AI key
  'rosterwarden-sync.your-name.workers.dev',                               // an example in a comment
  'www.w3.org',                                                            // the SVG namespace
]);

/** The policy's directives, as { name: [sources] }. */
function policy() {
  const line = readFileSync(join(ROOT, '_headers'), 'utf8').split('\n')
    .find((l) => l.trim().startsWith('Content-Security-Policy:'));
  const value = line.slice(line.indexOf(':') + 1);
  return Object.fromEntries(value.split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0])
    .map(([name, ...sources]) => [name, sources]));
}

/** Every https:// host named anywhere in js/, with the file it was found in. */
function hostsInCode(dir = join(ROOT, 'js')) {
  const found = new Map();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [host, file] of hostsInCode(path)) found.set(host, file);
    } else if (entry.name.endsWith('.js')) {
      for (const [, host] of readFileSync(path, 'utf8').matchAll(/https:\/\/([a-z0-9.-]+)/gi)) found.set(host.toLowerCase(), entry.name);
    }
  }
  return found;
}

test('every outside host in the code is allowed by the policy, or only ever linked to', () => {
  const csp = policy();
  const allowed = new Set([...csp['connect-src'], ...csp['frame-src']]
    .filter((s) => s.startsWith('https://')).map((s) => new URL(s).host));
  for (const [host, file] of hostsInCode()) {
    assert.ok(allowed.has(host) || LINK_ONLY.has(host),
      `${host} (named in ${file}) isn't in the Content-Security-Policy in _headers: add it to connect-src `
      + 'or frame-src there, or to LINK_ONLY here if the app only links to it');
  }
});

test('the policy stays strict', () => {
  const csp = policy();
  // Besides the app's own code, only Cloudflare Web Analytics' visit counter, which Cloudflare adds to the page.
  assert.deepEqual(csp['script-src'], ["'self'", 'https://static.cloudflareinsights.com']);
  assert.deepEqual(csp['style-src'], ["'self'"]);
  assert.deepEqual(csp['object-src'], ["'none'"]);
  assert.deepEqual(csp['frame-ancestors'], ["'none'"]);
  for (const sources of Object.values(csp)) {
    assert.ok(!sources.some((s) => s.includes('unsafe') || s === '*'), `too loose: ${sources.join(' ')}`);
  }
});
