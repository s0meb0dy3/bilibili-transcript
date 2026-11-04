import { readFile, access, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const extension = new URL('../extension/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', extension), 'utf8'));
const resources = new Set([
  ...manifest.content_scripts.flatMap(script => script.js),
  ...manifest.web_accessible_resources.flatMap(group => group.resources),
  manifest.background.service_worker, manifest.options_page, manifest.side_panel.default_path,
  ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)
]);
for (const html of [manifest.options_page, manifest.side_panel.default_path]) {
  const source = await readFile(new URL(html, extension), 'utf8');
  for (const match of source.matchAll(/(?:src|href)="([^"#]+)"/g)) resources.add(match[1]);
}
for (const resource of resources) await access(new URL(resource, extension));
const scripts = (await readdir(extension, { recursive: true })).filter(name => name.endsWith('.js'));
for (const script of scripts) {
  const result = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(script, extension))], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${script}: ${result.stderr}`);
}
console.log(`Native side panel package OK (${resources.size} resources, ${scripts.length} JavaScript files)`);
