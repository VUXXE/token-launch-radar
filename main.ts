// Token Launch Radar entrypoint (Node 22, standard library only, erasable TS).
// Reads a sealed DefiLlama snapshot, ranks pre-token protocols by implied launch value, and writes:
//   out/board.json, out/data.js, out/dashboard/*, out/screenshots/*, out/dossier.json
// Run: mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const root = fileURLToPath(new URL('.', import.meta.url));

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : fallback;
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token-radar: snapshot not found at ${inputFile}\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue) {
  process.stderr.write(`token-radar: board invalid: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

function copyDir(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const src = join(from, name);
    if (!statSync(src).isFile()) continue;
    copyFileSync(src, join(to, name));
    copied.push(name);
  }
  return copied;
}

const dash = copyDir(join(root, 'dashboard'), join(out, 'dashboard'));
if (dash.length === 0) {
  process.stderr.write('token-radar: dashboard/ is empty\n');
  process.exit(1);
}
const shots = copyDir(join(root, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token-radar: need 3 screenshots, found ${shots.length}\n`);
  process.exit(1);
}

// Dossier written last from the composed /output (scorer rebuilds and compares bytes).
writeFileSync(join(out, 'dossier.json'), buildDossier(out, {
  text_max_bytes: 65536,
  screenshots: { max: 4, max_bytes: 524288 },
  dashboard: { max_files: 400, max_bytes: 4194304 },
}));

process.stdout.write(
  `token-radar: screen: ${radar.screen.pre_token_total} pre-token, ${radar.screen.excluded_as_product} excluded as products, ` +
  `${radar.screen.candidates} launch candidates, ${radar.screen.watchlist_size} on watchlist, ${radar.screen.below_floor} below floor\n` +
  `token-radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} watchlist, ${board.length} ranked pre-token, ${radar.live.length} live comparables\n` +
  `token-radar: wrote board.json, data.js, dashboard (${dash.length} files), screenshots (${shots.length}), dossier.json -> ${out}\n`,
);
