import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseText, normalize } from '../lib/input.js';
const folder = process.argv[2];
if (!folder) throw new Error('Usage: node scripts/import-pack.js "path/to/episode-folder"');
const files = (await readdir(folder)).filter(f => f.endsWith('.txt')).sort();
const rows = [];
const manifest = [];
for (const file of files) {
  const records = parseText(await readFile(path.join(folder, file), 'utf8'), file.replace(/\.txt$/, ''));
  rows.push(...records);
  manifest.push({ file, records: records.length, episode: records[0]?.episode });
}
const source = normalize(rows);
await mkdir('private-inputs', { recursive: true });
await writeFile('private-inputs/show.json', JSON.stringify(source.records, null, 2));
await writeFile('private-inputs/import-manifest.json', JSON.stringify(manifest, null, 2));
console.log(`Imported ${files.length} files, ${source.episodes.size} episodes, ${source.records.length} records. Saved only in ignored private-inputs/.`);
