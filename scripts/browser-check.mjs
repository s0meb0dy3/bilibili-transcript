// Run the optional Ego browser harness with this checkout's absolute path.
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const template = await readFile(new URL('./browser/native-sidebar.mjs', import.meta.url), 'utf8');
const source = template.replace('__PROJECT_ROOT__', JSON.stringify(root));

const guide = spawnSync('ego-browser', ['skill'], { stdio: 'inherit' });
if (guide.error) throw guide.error;
if (guide.status !== 0) process.exit(guide.status || 1);

const result = spawnSync('ego-browser', ['nodejs'], {
  input: source,
  stdio: ['pipe', 'inherit', 'inherit']
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
