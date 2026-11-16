// Token Launch Radar model (implied-v1).
//
// Ranks only pre-token protocols from a sealed DefiLlama snapshot. A protocol is pre-token when both
// gecko_id and symbol are null; token-bearing protocols are excluded from the ranked board and exposed
// separately as live comparables (the market's own values).
//
// Implied launch value uses only snapshot fields: tvl_usd, change_7d, listed_at (age vs as_of).
// No protocol name is special-cased and no hand-made list influences the score.
//
//   implied = round( tvl_usd * category_multiple * momentum * maturity )
//
// category_multiple: median(mcap_usd / tvl_usd) over token-bearing protocols in the same category with
//   valid mcap_usd > 0 and tvl_usd > 0. Requires >= 3 peers; otherwise falls back to the global median
//   over all such token-bearing protocols. Clamped to [0.05, 2.00] so one outlier category cannot dominate.
// momentum: bounded multiplier from change_7d (percent). change_7d null => treated as 0% (neutral, documented).
//   clamped change c = clamp(change_7d_or_0, -60, 120); momentum = 1 + c/100 * 0.5 => range [0.70, 1.60].
//   Strong rise raises value, collapse lowers it, bounded both ways.
// maturity: bounded multiplier rising with days the protocol has been tracked with no token (listed_at to as_of).
//   listed_at null => age unknown, default 365 days (documented, mid-history neutral).
//   age_d = clamp(age_days, 0, 1825); maturity = 0.70 + (age_d / 1825) * 0.60 => range [0.70, 1.30].
//   A protocol running for years without launching has more to launch.
//
// Values are rounded to whole dollars, kept >= 1, and rows are ordered by descending implied value with
// exact ranks 1..N. Each row carries the breakdown (multiple, momentum, maturity, age_days, peer_count).

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export const MODEL_VERSION = 'implied-v1';

export interface ValueBreakdown {
  category_multiple: number;
  momentum_multiplier: number;
  maturity_multiplier: number;
  age_days: number;
  peer_count: number;
  multiple_source: 'category' | 'global';
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  implied_value_usd: number;
  model_version: string;
  category_multiple: number;
  momentum_multiplier: number;
  maturity_multiplier: number;
  age_days: number;
  peer_count: number;
  multiple_source: 'category' | 'global';
  farm_steps: string[];
}

export interface LiveComparable {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  symbol: string | null;
  mcap_tvl: number | null;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  watchlist: string[];
  rows: BoardRow[];
  live: LiveComparable[];
  categories: string[];
  chains: string[];
}

const DAY = 86_400_000;
const MULT_MIN = 0.05;
const MULT_MAX = 2.0;
const CHANGE_FLOOR = -60;
const CHANGE_CAP = 120;
const MOMENTUM_WEIGHT = 0.5;
const AGE_DEFAULT = 365; // days, when listed_at is null (documented default)
const AGE_CAP = 1825; // 5 years
const MATURITY_BASE = 0.7;
const MATURITY_RANGE = 0.6;

export function isPreToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

function median(values: number[]): number {
  if (values.length === 0) return 0.2;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

export function ageDays(asOf: string, listedAt: string | null): number {
  if (listedAt === null) return AGE_DEFAULT;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return AGE_DEFAULT;
  return Math.max(0, Math.floor((a - b) / DAY));
}

export interface MultipleInfo { multiple: number; peer_count: number; source: 'category' | 'global' }

export function computeMultiples(protocols: SnapshotProtocol[]): { byCategory: Map<string, MultipleInfo>; global: MultipleInfo } {
  const token = protocols.filter((p) => !isPreToken(p) && typeof p.mcap_usd === 'number' && p.mcap_usd! > 0 && p.tvl_usd > 0);
  const globalVals = token.map((p) => p.mcap_usd! / p.tvl_usd);
  const globalMed = clamp(median(globalVals), MULT_MIN, MULT_MAX);
  const global: MultipleInfo = { multiple: globalMed, peer_count: globalVals.length, source: 'global' };
  const byCatVals = new Map<string, number[]>();
  for (const p of token) {
    const cat = p.category ?? '__none__';
    const arr = byCatVals.get(cat) ?? [];
    arr.push(p.mcap_usd! / p.tvl_usd);
    byCatVals.set(cat, arr);
  }
  const byCategory = new Map<string, MultipleInfo>();
  for (const [cat, vals] of byCatVals.entries()) {
    if (vals.length >= 3) {
      byCategory.set(cat, { multiple: clamp(median(vals), MULT_MIN, MULT_MAX), peer_count: vals.length, source: 'category' });
    } else {
      byCategory.set(cat, { multiple: globalMed, peer_count: globalVals.length, source: 'global' });
    }
  }
  return { byCategory, global };
}

export function multipleFor(category: string | null, info: { byCategory: Map<string, MultipleInfo>; global: MultipleInfo }): MultipleInfo {
  const key = category ?? '__none__';
  return info.byCategory.get(key) ?? info.global;
}

export function scoreProtocol(p: SnapshotProtocol, asOf: string, mult: MultipleInfo): { implied: number; breakdown: ValueBreakdown } {
  const age = ageDays(asOf, p.listed_at);
  // null change_7d => 0% (neutral momentum), documented.
  const rawChange = typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : 0;
  const c = clamp(rawChange, CHANGE_FLOOR, CHANGE_CAP);
  const momentum = 1 + (c / 100) * MOMENTUM_WEIGHT;
  const ageC = clamp(age, 0, AGE_CAP);
  const maturity = MATURITY_BASE + (ageC / AGE_CAP) * MATURITY_RANGE;
  const raw = p.tvl_usd * mult.multiple * momentum * maturity;
  const implied = Math.max(1, Math.round(raw));
  return {
    implied,
    breakdown: {
      category_multiple: round4(mult.multiple),
      momentum_multiplier: round4(momentum),
      maturity_multiplier: round4(maturity),
      age_days: age,
      peer_count: mult.peer_count,
      multiple_source: mult.source,
    },
  };
}

function fmtMoney(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${Math.round(n)}`;
}

function firstChain(chains: string[]): string {
  return chains.length > 0 ? chains[0]! : 'its primary chain';
}

function chainList(chains: string[]): string {
  if (chains.length === 0) return 'its supported chains';
  if (chains.length === 1) return chains[0]!;
  if (chains.length === 2) return `${chains[0]} and ${chains[1]}`;
  return `${chains[0]}, ${chains[1]} and ${chains.length - 2} more chains`;
}

function capBucket(tvl: number): 'large' | 'mid' | 'small' {
  if (tvl >= 1_000_000_000) return 'large';
  if (tvl >= 100_000_000) return 'mid';
  return 'small';
}

function gasCost(chains: string[], bucket: 'large' | 'mid' | 'small'): string {
  const c = (chains[0] ?? '').toLowerCase();
  const l2 = ['base', 'arbitrum', 'optimism', 'blast', 'linea', 'scroll', 'zksync', 'mode', 'mantle', 'polygon', 'bsc', 'avalanche'];
  const cheap = l2.some((x) => c.includes(x));
  if (cheap) return bucket === 'large' ? '~$2-5 in gas' : '~$1-3 in gas';
  if (c.includes('ethereum')) return bucket === 'large' ? '~$10-30 in gas' : '~$5-15 in gas';
  return '~$1-8 in gas';
}

function holdWindow(age: number): string {
  if (age >= 730) return '6-12 weeks';
  if (age >= 365) return '4-8 weeks';
  if (age >= 180) return '3-6 weeks';
  return '2-4 weeks';
}

function sizeFor(bucket: 'large' | 'mid' | 'small'): string {
  if (bucket === 'large') return '$500-$2,000';
  if (bucket === 'mid') return '$200-$1,000';
  return '$50-$300';
}

function ensureBounds(steps: string[]): string[] {
  // normalize to 3..12 and each 20..600 chars after trim
  let out = steps.map((s) => s.trim()).filter((s) => s.length > 0);
  if (out.length > 12) out = out.slice(0, 12);
  while (out.length < 3) out.push('Monitor the protocol dashboard weekly and record balances, points, and any announced criteria to keep your position eligible. Cost: free, ~10 minutes weekly.');
  return out.map((s) => {
    let t = s;
    if (t.length < 20) t = t + ' (track progress weekly).';
    if (t.length > 600) t = t.slice(0, 597).trimEnd() + '...';
    if (t.length < 20) t = (t + ' Allow 10-15 minutes.').slice(0, 600);
    return t;
  });
}

export function farmStepsFor(p: SnapshotProtocol, ageDaysVal: number): string[] {
  const name = p.name;
  const cat = (p.category ?? 'Protocol').toLowerCase();
  const chain = firstChain(p.chains);
  const chains = chainList(p.chains);
  const bucket = capBucket(p.tvl_usd);
  const gas = gasCost(p.chains, bucket);
  const size = sizeFor(bucket);
  const hold = holdWindow(ageDaysVal);
  const tvlStr = fmtMoney(p.tvl_usd);
  const steps: string[] = [];

  steps.push(`Research ${name} on ${chains}: review docs, audits, and contract addresses; confirm it is still pre-token with ${tvlStr} TVL before depositing. Cost: free, ~30-45 minutes.`);

  if (/lend|borrow|cdp|credit/.test(cat)) {
    steps.push(`Supply ${size} of a supported stablecoin or blue-chip asset into ${name} on ${chain} to register onchain lending activity. Cost: deposit amount + ${gas}, ~10 minutes.`);
    if (bucket !== 'small') steps.push(`Optionally borrow a small amount (<=30% LTV) against your ${name} collateral and repay after a few days to add borrow-side history. Cost: interest + ${gas} per tx, ~15 minutes.`);
    steps.push(`Keep funds supplied in ${name} for ${hold}, maintaining utilization and avoiding liquidation; refresh position weekly. Cost: opportunity cost on ${size}, ~10 minutes/week.`);
  } else if (/dex|exchange|amm|perp|deriv|trading/.test(cat)) {
    steps.push(`Bridge ${size} to ${chain} and execute 4-8 swaps on ${name} across different weeks to build consistent trading volume. Cost: ${gas} plus ~0.05-0.3% swap fees per trade, ~20 minutes total.`);
    if (/perp|deriv/.test(cat)) {
      steps.push(`Open and close small leveraged positions on ${name} with low size (1-2% of equity) to show derivatives usage without excess risk. Cost: funding/fees + ${gas}, ~15 minutes/session.`);
    } else {
      steps.push(`Provide ${size} as liquidity in a main pool on ${name} and hold for ${hold} to accumulate LP time and fee history. Cost: deposit + ${gas}, impermanent loss risk, ~15 minutes.`);
    }
    steps.push(`Repeat modest volume on ${name} weekly for ${hold} rather than one burst; log tx hashes to evidence organic activity. Cost: ${gas} weekly, ~10 minutes/week.`);
  } else if (/bridge|cross/.test(cat)) {
    steps.push(`Bridge ${size} through ${name} to ${chain} (and back once) using official routes to create verifiable bridge transactions. Cost: bridge fee ~0.05-0.2% + ${gas}, ~15-30 minutes.`);
    steps.push(`Use the bridged assets in a simple onchain action (swap or deposit) after crossing via ${name} to show destination usage. Cost: ${gas}, ~10 minutes.`);
    steps.push(`Perform 2-4 spaced transfers via ${name} over ${hold} to demonstrate recurring usage. Cost: fees as above per transfer, ~15 minutes each.`);
  } else if (/staking|restak|liquid/.test(cat)) {
    steps.push(`Stake or restake ${size} of the supported asset through ${name} on ${chain} to receive its liquid receipt token. Cost: stake amount + ${gas}, ~10 minutes.`);
    steps.push(`Hold the ${name} receipt token for ${hold}; optionally use it in a whitelisted DeFi venue if documented by ${name}. Cost: smart-contract risk, ${gas} if moved, ~10 minutes.`);
    steps.push(`Claim or compound any native rewards on ${name} monthly and restake to keep the position active. Cost: ${gas} per claim, ~10 minutes.`);
  } else if (/yield|farm|aggregator|vault/.test(cat)) {
    steps.push(`Deposit ${size} into a primary vault or strategy on ${name} on ${chain} and note the share token received. Cost: deposit + ${gas}, ~10 minutes.`);
    steps.push(`Leave the deposit in ${name} for ${hold} to accrue strategy runtime; avoid frequent churn that may not count. Cost: strategy/contract risk, ~5 minutes/week to monitor.`);
    steps.push(`Harvest or rebalance through ${name} if the UI offers it, then withdraw a small test amount to confirm exits work. Cost: ${gas}, ~10 minutes.`);
  } else if (/rwa|real world/.test(cat)) {
    steps.push(`Complete any KYC or eligibility steps required by ${name}, then allocate ${size} to its RWA product on ${chain} if permitted in your jurisdiction. Cost: deposit + ${gas} (and possible onboarding time), ~30-60 minutes.`);
    steps.push(`Hold the ${name} position for ${hold} and track yield distributions or statements in-app. Cost: opportunity and compliance risk, ~10 minutes/week.`);
  } else if (/risk|curator|allocator/.test(cat)) {
    steps.push(`Deposit ${size} into a curated vault managed via ${name} on ${chain}, choosing a conservative risk profile. Cost: deposit + ${gas}, ~10 minutes.`);
    steps.push(`Maintain the allocation in ${name} for ${hold} and review curator updates or rebalances. Cost: manager/contract risk, ~10 minutes/week.`);
  } else {
    steps.push(`Deposit or interact with ${size} in the core product of ${name} on ${chain} following official docs to create a baseline position. Cost: amount + ${gas}, ~15 minutes.`);
    steps.push(`Perform 2-3 additional meaningful actions on ${name} (e.g. stake, vote, or secondary feature use) spread over ${hold}. Cost: ${gas} per action, ~20 minutes total.`);
    steps.push(`Maintain at least one active position in ${name} for ${hold} and monitor announcements for points or eligibility criteria. Cost: opportunity cost, ~10 minutes/week.`);
  }

  steps.push(`Track all ${name} activity (addresses, dates, amounts, tx hashes) in a spreadsheet so you can evidence usage if a token launches. Cost: free, ~10 minutes setup.`);

  // ensure protocol name appears in at least one step (it does many times, but guarantee)
  if (!steps.some((s) => s.includes(name))) {
    steps[0] = `Use ${name}: ${steps[0]}`;
  }
  return ensureBounds(steps);
}

export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const mults = computeMultiples(snapshot.protocols);
  const pre = snapshot.protocols.filter(isPreToken);
  const scored = pre.map((p) => {
    const mult = multipleFor(p.category, mults);
    const { implied, breakdown } = scoreProtocol(p, snapshot.as_of, mult);
    const row: BoardRow = {
      rank: 0,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd,
      listed_at: p.listed_at,
      gecko_id: p.gecko_id,
      symbol: p.symbol,
      token_status: 'pre-token',
      implied_value_usd: implied,
      model_version: MODEL_VERSION,
      category_multiple: breakdown.category_multiple,
      momentum_multiplier: breakdown.momentum_multiplier,
      maturity_multiplier: breakdown.maturity_multiplier,
      age_days: breakdown.age_days,
      peer_count: breakdown.peer_count,
      multiple_source: breakdown.multiple_source,
      farm_steps: farmStepsFor(p, breakdown.age_days),
    };
    return row;
  });
  scored.sort((a, b) => b.implied_value_usd - a.implied_value_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  scored.forEach((r, i) => { r.rank = i + 1; });
  return scored;
}

export function buildLive(snapshot: Snapshot): LiveComparable[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p))
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      symbol: p.symbol,
      mcap_tvl: p.mcap_usd && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }))
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd);
}

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot);
  const live = buildLive(snapshot);
  const categories = Array.from(new Set(snapshot.protocols.map((p) => p.category).filter((c): c is string => !!c))).sort();
  const chains = Array.from(new Set(snapshot.protocols.flatMap((p) => p.chains))).sort();
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    watchlist: snapshot.watchlist,
    rows: board,
    live,
    categories,
    chains,
  };
  return { board, radar };
}

export class SnapshotError extends Error {
  constructor(message: string) { super(message); this.name = 'SnapshotError'; }
}

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new SnapshotError('snapshot.json is not valid JSON'); }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json must be an object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string') throw new SnapshotError('snapshot.json missing as_of');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json missing source');
  if (typeof o.floor_usd !== 'number') throw new SnapshotError('snapshot.json missing floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json missing protocols');
  if (!Array.isArray(o.watchlist)) throw new SnapshotError('snapshot.json missing watchlist');
  const protocols = (o.protocols as unknown[]).map((v, i) => {
    if (typeof v !== 'object' || v === null) throw new SnapshotError(`protocol ${i} invalid`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number') {
      throw new SnapshotError(`protocol ${i} missing slug/name/tvl_usd`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    } as SnapshotProtocol;
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: (o.watchlist as unknown[]).filter((s): s is string => typeof s === 'string'),
  };
}

export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100) return `board has ${board.length} rows (<100)`;
  if (board.length > 4000) return `board has ${board.length} rows (>4000)`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'duplicate slugs in board';
  for (const w of snapshot.watchlist) if (!slugs.has(w)) return `missing watchlist slug ${w}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} missing or duplicated`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `values rise at rank ${i + 1}`;
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has non-positive implied_value_usd`;
    if (!Array.isArray(r.farm_steps) || r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps?.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = String(s).trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has farm step length ${t.length}`;
    }
  }
  // ensure only pre-token ranked
  for (const r of board) if (r.gecko_id !== null || r.symbol !== null) return `${r.slug} is token-bearing but ranked`;
  return null;
}

export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
