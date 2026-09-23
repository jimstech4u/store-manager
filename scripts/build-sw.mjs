/**
 * WRITE THE SERVICE WORKER, STAMPED WITH THE BUILD IT CAME FROM.
 *
 * Runs as `prebuild`, so `npm run build` — which is what Vercel runs — always writes a fresh
 * `public/sw.js` before Next collects the public folder.
 *
 * WHY THIS EXISTS AT ALL. A browser decides a service worker is new by comparing the bytes it
 * fetches against the bytes it installed. The version used to be a hand-written `'v5'`, so every
 * deploy that did not happen to edit `sw.js` shipped a byte-identical worker: no update was ever
 * detected, nothing entered `waiting`, and the "A new version is ready" dialog never had anything
 * to show. A shop could be running a build from a fortnight ago with the app insisting it was
 * current. Four deploys went out like that before it was noticed from the outside.
 *
 * The version is the COMMIT, not a timestamp: a rebuild of the same code should not tell a shop to
 * relaunch for nothing, and two deploys of the same commit really are the same app.
 */

import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = join(root, 'sw', 'sw.template.js');
const OUT = join(root, 'public', 'sw.js');
const PLACEHOLDER = '__BUILD_VERSION__';

/** Vercel says which commit it is building; a laptop has to be asked. */
function buildVersion() {
  const fromCI = process.env.VERCEL_GIT_COMMIT_SHA;
  if (fromCI) return fromCI.slice(0, 12);

  try {
    return execSync('git rev-parse --short=12 HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    /*
     * No git, no CI — a tarball build. A timestamp is worse than a commit (it asks every shop to
     * relaunch on every rebuild) but far better than a constant, which asks nobody ever.
     */
    return `t${Date.now()}`;
  }
}

const version = buildVersion();
const template = readFileSync(TEMPLATE, 'utf8');

if (!template.includes(PLACEHOLDER)) {
  // Fail the build rather than ship a worker that can never announce itself again.
  console.error(`[build-sw] ${PLACEHOLDER} is missing from sw/sw.template.js — refusing to write a worker with no build id.`);
  process.exit(1);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, template.replaceAll(PLACEHOLDER, version));
console.log(`[build-sw] public/sw.js written for build ${version}`);
