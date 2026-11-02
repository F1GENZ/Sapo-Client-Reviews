import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '..');

const readEcosystem = (env: Record<string, string> = {}): { name: string; node_args: string; env: Record<string, string> } =>
  JSON.parse(
    execFileSync(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(require("./ecosystem.config.cjs").apps[0]))'],
      { cwd: repoRoot, env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' },
    ),
  );

test('the ecosystem forwards the commit the deploy sets, because PM2 keeps the BUILD_SHA it started with', () => {
  const app = readEcosystem({ BUILD_SHA: 'deadbeefcafe' });
  assert.equal(app.env.BUILD_SHA, 'deadbeefcafe');
  assert.equal(app.env.NODE_ENV, 'production');
});

test('a start without a BUILD_SHA declares no BUILD_SHA, so nothing invents a build identity', () => {
  const app = readEcosystem();
  assert.equal(Object.hasOwn(app.env, 'BUILD_SHA'), false);
});

test('the process still reads the VPS .env and pins IPv4 for the Sapo API', () => {
  const app = readEcosystem();
  assert.match(app.node_args, /--env-file=\.env/);
  assert.match(app.node_args, /--dns-result-order=ipv4first/);
});
