/**
 * test/action-keys.test.mjs → hooks/action-keys.mjs
 *
 * Shell / tool intent (RFC-session-triggers §5.1): the phase vocabulary that
 * sits beside the Canonical Action Key. Keys stay sonic vocabulary; intent
 * says whether an action mutates, verifies, or only reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TOOL_ACTION_KEYS, SHELL_INTENTS, shellIntent, toolIntent,
} from '../hooks/action-keys.mjs';

test('TOOL_ACTION_KEYS unchanged — intent does not touch the sonic key set', () => {
  assert.deepEqual([...TOOL_ACTION_KEYS].sort(), [
    'agent', 'bash_git', 'bash_other', 'bash_run', 'edit', 'grep_glob', 'other', 'read', 'web', 'write',
  ]);
  assert.deepEqual([...SHELL_INTENTS].sort(), ['mutate', 'read', 'verify']);
});

test('shellIntent — git splits by subcommand', () => {
  assert.equal(shellIntent('git status'), 'read');
  assert.equal(shellIntent('git log --oneline -5'), 'read');
  assert.equal(shellIntent('git diff HEAD'), 'read');
  assert.equal(shellIntent('git commit -m "x"'), 'mutate');
  assert.equal(shellIntent('git push origin main'), 'mutate');
  assert.equal(shellIntent('git add -A'), 'mutate');
  assert.equal(shellIntent('git merge feature'), 'mutate');
  assert.equal(shellIntent('git checkout -b kaaro/x'), 'mutate');
});

test('shellIntent — package managers: test/build verify, install mutates', () => {
  assert.equal(shellIntent('npm test'), 'verify');
  assert.equal(shellIntent('npm run build'), 'verify');
  assert.equal(shellIntent('npm run lint'), 'verify');
  assert.equal(shellIntent('node --test test/x.test.mjs'), 'verify');
  assert.equal(shellIntent('pytest -q'), 'verify');
  assert.equal(shellIntent('cargo test'), 'verify');
  assert.equal(shellIntent('npx tsc --noEmit'), 'verify');
  assert.equal(shellIntent('npm install'), 'mutate');
  assert.equal(shellIntent('npm i left-pad'), 'mutate');
  assert.equal(shellIntent('pip install requests'), 'mutate');
});

test('shellIntent — filesystem mutation and redirects', () => {
  assert.equal(shellIntent("sed -i 's/a/b/' f.txt"), 'mutate');
  assert.equal(shellIntent('mv a b'), 'mutate');
  assert.equal(shellIntent('rm -rf dist'), 'mutate');
  assert.equal(shellIntent('mkdir -p out'), 'mutate');
  assert.equal(shellIntent('echo hi > notes.txt'), 'mutate');
  assert.equal(shellIntent('cat a >> b'), 'mutate');
  assert.equal(shellIntent('ls -la'), 'read');
  assert.equal(shellIntent('cat package.json'), 'read');
  assert.equal(shellIntent('grep -rn foo src'), 'read');
});

test('shellIntent — stderr/null redirects are not writes', () => {
  assert.equal(shellIntent('ls missing 2>/dev/null'), 'read');
  assert.equal(shellIntent('git status 2>&1'), 'read');
  assert.equal(shellIntent('Get-ChildItem 2>$null'), 'read');
  assert.equal(shellIntent('node --test > /dev/null'), 'verify');
});

test('shellIntent — > inside quotes or arrows is not a redirect', () => {
  assert.equal(shellIntent('node -e "setTimeout(()=>{},1500)"'), 'read');
  assert.equal(shellIntent("node -e 'process.stdout.write(a > b ? 1 : 0)'"), 'read');
  assert.equal(shellIntent('grep -n "a -> b" notes.md'), 'read');
  assert.equal(shellIntent('node -e "x" > out.json'), 'mutate');
});

test('shellIntent — PowerShell cmdlets (Windows sessions)', () => {
  assert.equal(shellIntent('New-Item -ItemType Directory out'), 'mutate');
  assert.equal(shellIntent('Remove-Item -Recurse dist'), 'mutate');
  assert.equal(shellIntent('Set-Content -Path a.txt -Value x'), 'mutate');
  assert.equal(shellIntent('Get-Content a.txt'), 'read');
});

test('shellIntent — chained commands: strongest segment wins (mutate > verify > read)', () => {
  assert.equal(shellIntent('cd /d/src && git status'), 'read');
  assert.equal(shellIntent('cd repo && npm test'), 'verify');
  assert.equal(shellIntent('npm test && git commit -m x'), 'mutate');
  assert.equal(shellIntent('git add . ; git status'), 'mutate');
  assert.equal(shellIntent('ls | head -5'), 'read');
});

test('shellIntent — missing command text is null, never guessed as read', () => {
  assert.equal(shellIntent(null), null);
  assert.equal(shellIntent(undefined), null);
  assert.equal(shellIntent(''), null);
  assert.equal(shellIntent('   '), null);
});

test('toolIntent — file tools by canonical key', () => {
  assert.equal(toolIntent('Write', { file_path: 'a' }), 'mutate');
  assert.equal(toolIntent('Edit', {}), 'mutate');
  assert.equal(toolIntent('apply_patch', {}), 'mutate');
  assert.equal(toolIntent('Read', {}), 'read');
  assert.equal(toolIntent('Grep', {}), 'read');
  assert.equal(toolIntent('WebFetch', {}), 'read');
  assert.equal(toolIntent('Agent', {}), 'read');
  assert.equal(toolIntent('SomethingNew', {}), 'read');
});

test('toolIntent — shells delegate to shellIntent (command or cmd)', () => {
  assert.equal(toolIntent('Bash', { command: 'git commit -m x' }), 'mutate');
  assert.equal(toolIntent('PowerShell', { command: 'npm test' }), 'verify');
  assert.equal(toolIntent('shell_command', { cmd: 'ls' }), 'read');
  assert.equal(toolIntent('run_in_terminal', {}), null);
  // codex can carry argv arrays
  assert.equal(toolIntent('shell_command', { command: ['git', 'push'] }), 'mutate');
  assert.equal(toolIntent('Bash', null), null);
});
