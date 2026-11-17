// Token Launch Radar model (implied-v2).
//
// Ranks only launch candidates from a sealed DefiLlama snapshot.
//
// A protocol is a launch candidate when its own record says it has no token (gecko_id and symbol are
// both null) and it is not a product of a token that already trades. The screen is the watchlist's own
// exclusion rule applied to the whole snapshot with no TVL floor:
//
//   - category is not Bridge, Canonical Bridge, Liquid Staking, Liquid Restaking, Restaked BTC or CEX;
//   - name does not end in a version marker (a space plus V2, v2, 2.0 or the like);
//   - name carries no whole word wrapped, staked or staking in any case;
//   - name does not begin with Binance, Coinbase, Bybit, Kraken, Bitget, OKX, Bitfinex or Gemini.
//
// A radar of bridge wrappers and exchange products is noise, because those are not protocols waiting on
// a launch of their own: WBTC already is Bitcoin, Base Bridge is a bridge, and a CEX is an exchange product.
// The screen is the watchlist's rule with the $50M floor removed, so below-floor candidates stay on the
// board (the floor is where the house's reading started, never where ours stops). Token-bearing protocols
// are never ranked; they are exposed separately as live comparables (the market's own values).
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
// exact ranks 1..N. Each row carries the breakdown (multiple, momentum, maturity, age_days, peer_count),
// its watchlist flag, its TVL rank and its rank inside its own category.

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

export const MODEL_VERSION = 'implied-v2';

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
  on_watchlist: boolean;
  implied_value_usd: number;
  model_version: string;
  category_multiple: number;
  momentum_multiplier: number;
  maturity_multiplier: number;
  age_days: number;
  peer_count: number;
  multiple_source: 'category' | 'global';
  tvl_rank: number;
  category_rank: number;
  category_size: number;
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

export interface MultipleInfo { multiple: number; peer_count: number; source: 'category' | 'global' }

export interface ScreenStats {
  pre_token_total: number;
  excluded_as_product: number;
  candidates: number;
  watchlist_size: number;
  below_floor: number;
}

export interface MultiplesPayload {
  global: { multiple: number; peer_count: number };
  categories: Record<string, { multiple: number; peer_count: number; source: 'category' | 'global' }>;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  watchlist: string[];
  screen: ScreenStats;
  rows: BoardRow[];
  live: LiveComparable[];
  multiples: MultiplesPayload;
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

// The watchlist's own exclusion rule (input/README.md), applied without its floor.
const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const PRODUCT_WORD = /(^|\s)(wrapped|staked|staking)(\s|$)/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)(\s|$)/;

export function isPreToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

export function isLaunchCandidate(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return false;
  if (VERSION_SUFFIX.test(p.name)) return false;
  if (PRODUCT_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

export function screenSnapshot(snapshot: Snapshot): { candidates: SnapshotProtocol[]; stats: ScreenStats } {
  const pre = snapshot.protocols.filter(isPreToken);
  const candidates = pre.filter(isLaunchCandidate);
  const stats: ScreenStats = {
    pre_token_total: pre.length,
    excluded_as_product: pre.length - candidates.length,
    candidates: candidates.length,
    watchlist_size: new Set(snapshot.watchlist).size,
    below_floor: candidates.filter((p) => p.tvl_usd < snapshot.floor_usd).length,
  };
  return { candidates, stats };
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

function multiplesPayload(info: { byCategory: Map<string, MultipleInfo>; global: MultipleInfo }): MultiplesPayload {
  const categories: MultiplesPayload['categories'] = {};
  for (const [cat, m] of info.byCategory.entries()) {
    categories[cat] = { multiple: round4(m.multiple), peer_count: m.peer_count, source: m.source };
  }
  return {
    global: { multiple: round4(info.global.multiple), peer_count: info.global.peer_count },
    categories,
  };
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
  if (bucket === 'large') return '$1,000-$5,000';
  if (bucket === 'mid') return '$250-$1,000';
  return '$50-$250';
}

function planStep(action: string, cost: string, time: string): string {
  return `${action}. Cost: ${cost}. Time: ${time}.`;
}

function ensureBounds(steps: string[]): string[] {
  // normalize to 3..12 and each 20..600 chars after trim
  let out = steps.map((s) => s.trim()).filter((s) => s.length > 0);
  if (out.length > 12) out = out.slice(0, 12);
  while (out.length < 3) out.push('Monitor the protocol dashboard weekly and record balances, points, and any announced criteria to keep your position eligible. Cost: free. Time: ~10 minutes weekly.');
  return out.map((s) => {
    let t = s;
    if (t.length < 20) t = t + ' Track progress weekly.';
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

  if (/risk|curator/.test(cat)) {
    steps.push(planStep(
      `Research ${name} on ${chain}: confirm which lending market it curates for, then pick a curated USDC vault on ${chain}; check the curator, vault cap, fees and audits before depositing, against ${tvlStr} TVL`,
      'free',
      '30-45 minutes',
    ));
    steps.push(planStep(
      `Deposit ${size} of USDC into ${name}'s curated USDC vault on ${chain}, approve once, and confirm the position or share balance appears in the vault UI`,
      `deposit amount + ${gas}`,
      '10-15 minutes',
    ));
    steps.push(planStep(
      `Keep the ${name} position for ${hold}; check curator reallocation, vault utilisation and pause notices weekly, and exit if utilisation spikes or the curator changes strategy`,
      `opportunity cost on ${size} plus ${gas} per move`,
      `${hold}, about 10 minutes a week`,
    ));
    steps.push(planStep(
      `Test the exit: withdraw a small slice through ${name}'s withdrawal queue and confirm it settles before adding more capital`,
      `${gas} plus any exit fee`,
      '10-20 minutes plus queue time',
    ));
    steps.push(planStep(
      `Record the ${name} deposits, withdrawals, share token and tx hashes as dated evidence in case a token or points programme asks for usage history`,
      'free',
      '10 minutes setup, 5 minutes a week',
    ));
  } else if (/liquidity manager/.test(cat)) {
    steps.push(planStep(
      `Research ${name} on ${chain}: find which venues it manages liquidity on, its fee share, lock or cooldown and audits before committing capital`,
      'free',
      '30-45 minutes',
    ));
    steps.push(planStep(
      `Deposit ${size} into ${name}'s managed liquidity position on ${chain}; note the receipt token, its redemption terms and the performance fee`,
      `deposit amount + ${gas}`,
      '10-15 minutes',
    ));
    steps.push(planStep(
      `Hold the ${name} position for ${hold}; watch manager rebalancing, pool fee income and impermanent loss, and read each strategy update`,
      `opportunity cost on ${size}, plus impermanent-loss risk`,
      `${hold}, about 10 minutes a week`,
    ));
    steps.push(planStep(
      `Test the exit: redeem a small slice from ${name}, check the cooldown and the fee charged, and compare the proceeds with the deposit`,
      `${gas} plus any exit or performance fee`,
      '15-30 minutes plus cooldown',
    ));
    steps.push(planStep(
      `Log the ${name} deposits, redemptions, receipt token and tx hashes so the activity can be evidenced if a launch or points programme appears`,
      'free',
      '10 minutes setup, 5 minutes a week',
    ));
  } else if (/prediction/.test(cat)) {
    steps.push(planStep(
      `Research ${name} on ${chain}: read the resolution rules, fee schedule and collateral asset for the markets you plan to trade`,
      'free',
      '20-30 minutes',
    ));
    steps.push(planStep(
      `Trade ${size} across a few ${name} markets in different categories, sizing each position so a total loss stays tolerable`,
      `${gas} plus spread and trading fees`,
      '15-20 minutes',
    ));
    steps.push(planStep(
      `Hold at least one ${name} position to resolution so the record includes a settled outcome, not only entries`,
      `capital at risk until resolution`,
      'until the market resolves',
    ));
    steps.push(planStep(
      `Repeat a few trades on ${name} across categories over ${hold} to build a varied history rather than one burst`,
      `${gas} plus fees per trade`,
      `${hold}, about 10 minutes a week`,
    ));
    steps.push(planStep(
      `Claim resolved ${name} positions, withdraw the proceeds and log each market, outcome and tx hash as evidence`,
      `${gas} per claim`,
      '15-20 minutes',
    ));
  } else if (/basis|perp|deriv|option/.test(cat)) {
    steps.push(planStep(
      `Research ${name} on ${chain}: check contract specs, funding formula, margin collateral, oracle and liquidation rules before opening anything`,
      'free',
      '30-45 minutes',
    ));
    steps.push(planStep(
      `Deposit collateral and open then close a small ${name} position worth at most 2% of your equity to test execution and fees`,
      `${gas} plus taker fees`,
      '15-20 minutes',
    ));
    steps.push(planStep(
      `If ${name} supports it, run a small basis trade (long spot, short perp or the reverse) at ${size} and track the funding you pay or receive`,
      `funding cost on ${size} plus ${gas}`,
      '20-30 minutes to set up, check daily',
    ));
    steps.push(planStep(
      `Repeat small open-and-close cycles on ${name} across ${hold}, keeping leverage at or below 2x and never leaving a position unattended`,
      `funding and fees plus ${gas} per cycle`,
      `${hold}, about 15 minutes a session`,
    ));
    steps.push(planStep(
      `Close every ${name} position, withdraw collateral and log funding paid, fees and tx hashes as evidence of real usage`,
      `${gas} plus closing fees`,
      '15-20 minutes',
    ));
  } else if (/dex|exchange|amm|trading/.test(cat)) {
    steps.push(planStep(
      `Research ${name} on ${chain}: identify the main pool, its fee tier, routing and audits before trading or providing liquidity`,
      'free',
      '30-45 minutes',
    ));
    steps.push(planStep(
      `Fund ${size} on ${chain} and make 4-8 swaps through ${name} across different weeks instead of one burst, keeping each trade small`,
      `${gas} plus roughly 0.05-0.3% swap fee per trade`,
      '20-30 minutes setup, 10 minutes a week',
    ));
    steps.push(planStep(
      `Provide ${size} as liquidity in a main ${name} pool, note the fee tier and record the impermanent-loss exposure before confirming`,
      `deposit amount + ${gas}, with impermanent-loss risk`,
      '15-20 minutes',
    ));
    steps.push(planStep(
      `Hold the ${name} LP position for ${hold} and compare fees earned with impermanent loss weekly before deciding to stay`,
      `opportunity cost on ${size} and impermanent-loss risk`,
      `${hold}, about 10 minutes a week`,
    ));
    steps.push(planStep(
      `Withdraw the ${name} LP position, compare fees earned against impermanent loss and log swaps, LP txs and hashes as evidence`,
      `${gas} plus any withdrawal fee`,
      '15-20 minutes',
    ));
  } else if (/lend|cdp|credit|collateral/.test(cat)) {
    steps.push(planStep(
      `Research ${name} on ${chain}: read the markets, collateral factors, oracle and audits, and pick the stablecoin you will supply`,
      'free',
      '30-45 minutes',
    ));
    steps.push(planStep(
      `Supply ${size} of a supported stablecoin into ${name} on ${chain} and confirm the receipt or supplied balance appears`,
      `deposit amount + ${gas}`,
      '10-15 minutes',
    ));
    steps.push(planStep(
      `Optionally borrow a small amount against the ${name} position, keep the health factor above 2.0 and repay after a few days to build borrow-side history`,
      `borrow interest + ${gas} per transaction`,
      '15-20 minutes plus a few days',
    ));
    steps.push(planStep(
      `Keep funds supplied in ${name} for ${hold}; check the health factor and utilisation weekly and add collateral before any liquidation threshold`,
      `opportunity cost on ${size}`,
      `${hold}, about 5-10 minutes a week`,
    ));
    steps.push(planStep(
      `Exit cleanly: repay any ${name} loan in full, withdraw a test amount first and log supplied, borrowed and repaid amounts with tx hashes`,
      `${gas} per transaction`,
      '15-30 minutes',
    ));
  } else if (/rwa|real world|payment/.test(cat)) {
    steps.push(planStep(
      `Research ${name} on ${chain}: check eligibility, KYC requirements, the underlying asset, distribution cadence, redemption terms and your jurisdiction`,
      'free',
      '30-60 minutes',
    ));
    steps.push(planStep(
      `Complete the KYC or eligibility step for ${name}; if the product is not permitted where you live, stop here and record why instead of forcing it`,
      'free or an identity-verification fee',
      '1-3 days',
    ));
    steps.push(planStep(
      `Allocate ${size} to the ${name} product permitted in your jurisdiction, noting the legal wrapper, custody arrangement and redemption terms`,
      `deposit amount + ${gas} plus any onboarding fee`,
      '30-60 minutes',
    ));
    steps.push(planStep(
      `Hold the ${name} allocation for ${hold} and track distributions or statements at the cadence the product promises`,
      `opportunity cost and compliance risk`,
      `${hold}, about 10 minutes a week`,
    ));
    steps.push(planStep(
      `Request a small redemption from ${name}, confirm it settles on the stated timeline, and log statements, distribution dates and tx hashes`,
      `${gas} plus any redemption fee`,
      '1-5 days',
    ));
  } else if (/restak|staking|liquid stak/.test(cat)) {
    steps.push(planStep(
      `Research ${name} on ${chain}: check supported assets, the operator or AVS set, slashing conditions, unbonding period and audits`,
      'free',
      '30-45 minutes',
    ));
    steps.push(planStep(
      `Stake ${size} of the supported asset through ${name} on ${chain}, choose the operator or AVS deliberately and note the receipt token you receive`,
      `stake amount + ${gas}`,
      '10-15 minutes',
    ));
    steps.push(planStep(
      `Hold the ${name} receipt token for ${hold}; monitor slashing events, operator performance and the unbonding queue, and keep a liquid buffer outside`,
      `smart-contract and slashing risk, ${gas} if moved`,
      `${hold}, about 10 minutes a week`,
    ));
    steps.push(planStep(
      `Unstake a small slice through ${name} to test the unbonding window, confirm the receipt token burns and log the timestamps`,
      `${gas} plus any unbonding fee`,
      '10-15 minutes plus the unbonding wait',
    ));
    steps.push(planStep(
      `Record the ${name} stake, receipt token, operator choices and tx hashes so the position can be evidenced if a launch or points programme appears`,
      'free',
      '10 minutes setup, 5 minutes a week',
    ));
  } else if (/allocator|yield|vault|farm/.test(cat)) {
    steps.push(planStep(
      `Research ${name}: identify its flagship vault on ${chain}, read the strategy, share token, fees, cap, withdrawal queue and audits before depositing`,
      'free',
      '30-45 minutes',
    ));
    steps.push(planStep(
      `Deposit ${size} into ${name}'s flagship vault on ${chain}, note the share token address and the fee drag before confirming`,
      `deposit amount + ${gas}`,
      '10-15 minutes',
    ));
    steps.push(planStep(
      `Hold the ${name} position for ${hold}; check the share price, strategy allocation and withdrawal-queue depth weekly, and leave if the strategy changes`,
      `opportunity cost on ${size} plus the vault's management fee`,
      `${hold}, about 10 minutes a week`,
    ));
    steps.push(planStep(
      `Test the exit: redeem a small slice from ${name}, time how long the withdrawal queue takes and compare the amount received with the share value`,
      `${gas} plus any exit fee`,
      '15-30 minutes plus queue time',
    ));
    steps.push(planStep(
      `Log the ${name} deposits, redemptions, share token and tx hashes so the activity is documented if a token or points programme asks for it`,
      'free',
      '10 minutes setup, 5 minutes a week',
    ));
  } else if (/chain|bridge|cross/.test(cat)) {
    steps.push(planStep(
      `Research ${name} on ${chain}: check the bridge route, native DEX and lending venue, gas token, and audits before moving funds`,
      'free',
      '30-45 minutes',
    ));
    steps.push(planStep(
      `Bridge ${size} onto ${chain} through a documented route for ${name}, keep enough gas token for several transactions and verify the arrival`,
      `bridge fee around 0.05-0.2% + ${gas}`,
      '20-30 minutes',
    ));
    steps.push(planStep(
      `Use the chain: make 2-3 swaps on its native DEX and supply a small stable balance to its native lending venue, keeping the position modest`,
      `${gas} plus swap fees and deposit amount`,
      '20-30 minutes',
    ));
    steps.push(planStep(
      `Keep a balance active on ${chain} for ${hold} and make a small monthly transaction so the address has recurring history`,
      `${gas} monthly`,
      `${hold}, about 10 minutes a month`,
    ));
    steps.push(planStep(
      `Bridge a test amount back from ${chain}, confirm it arrives, and log balances, routes and tx hashes on both sides`,
      `bridge fee + ${gas}`,
      '20-30 minutes',
    ));
  } else {
    steps.push(planStep(
      `Research ${name} on ${chains}: review its docs, audits and contract addresses, and confirm it still records no token with ${tvlStr} TVL`,
      'free',
      '30-45 minutes',
    ));
    steps.push(planStep(
      `Use the core product of ${name} with ${size} on ${chain}, following the official docs to create a real baseline position`,
      `amount + ${gas}`,
      '15-20 minutes',
    ));
    steps.push(planStep(
      `Perform 2-3 additional meaningful actions on ${name} spread over ${hold}, such as staking, voting or using a secondary feature`,
      `${gas} per action`,
      `20-30 minutes total over ${hold}`,
    ));
    steps.push(planStep(
      `Keep at least one active ${name} position for ${hold} and watch announcements for points or eligibility criteria`,
      'opportunity cost',
      `${hold}, about 10 minutes a week`,
    ));
    steps.push(planStep(
      `Withdraw a test amount from ${name} to prove the exit works, then log addresses, dates, amounts and tx hashes as evidence`,
      `${gas}`,
      '15-20 minutes',
    ));
  }

  if (!steps.some((s) => s.includes(name))) {
    steps[0] = `Use ${name}: ${steps[0]}`;
  }
  return ensureBounds(steps);
}

export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const mults = computeMultiples(snapshot.protocols);
  const { candidates } = screenSnapshot(snapshot);
  const watch = new Set(snapshot.watchlist);
  const scored = candidates.map((p) => {
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
      on_watchlist: watch.has(p.slug),
      implied_value_usd: implied,
      model_version: MODEL_VERSION,
      category_multiple: breakdown.category_multiple,
      momentum_multiplier: breakdown.momentum_multiplier,
      maturity_multiplier: breakdown.maturity_multiplier,
      age_days: breakdown.age_days,
      peer_count: breakdown.peer_count,
      multiple_source: breakdown.multiple_source,
      tvl_rank: 0,
      category_rank: 0,
      category_size: 0,
      farm_steps: farmStepsFor(p, breakdown.age_days),
    };
    return row;
  });
  scored.sort((a, b) => b.implied_value_usd - a.implied_value_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  scored.forEach((r, i) => { r.rank = i + 1; });

  const byTvl = [...scored].sort((a, b) => b.tvl_usd - a.tvl_usd || a.rank - b.rank);
  byTvl.forEach((r, i) => { r.tvl_rank = i + 1; });

  const catKey = (r: BoardRow) => r.category ?? '__none__';
  const catCounts = new Map<string, number>();
  for (const r of scored) catCounts.set(catKey(r), (catCounts.get(catKey(r)) ?? 0) + 1);
  const catSeen = new Map<string, number>();
  for (const r of scored) {
    const key = catKey(r);
    const n = (catSeen.get(key) ?? 0) + 1;
    catSeen.set(key, n);
    r.category_rank = n;
    r.category_size = catCounts.get(key) ?? 1;
  }
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
  const screen = screenSnapshot(snapshot);
  const board = buildBoard(snapshot);
  const live = buildLive(snapshot);
  const mults = computeMultiples(snapshot.protocols);
  const categories = Array.from(new Set(snapshot.protocols.map((p) => p.category).filter((c): c is string => !!c))).sort();
  const chains = Array.from(new Set(snapshot.protocols.flatMap((p) => p.chains))).sort();
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    watchlist: snapshot.watchlist,
    screen: screen.stats,
    rows: board,
    live,
    multiples: multiplesPayload(mults),
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
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'duplicate slugs in board';
  const watch = new Set(snapshot.watchlist);
  for (const w of snapshot.watchlist) if (!slugs.has(w)) return `missing watchlist slug ${w}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} missing or duplicated`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `values rise at rank ${i + 1}`;
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has non-positive implied_value_usd`;
    if (r.gecko_id !== null || r.symbol !== null) return `${r.slug} is token-bearing but ranked`;
    const p = bySlug.get(r.slug);
    if (!p) return `${r.slug} is not in the snapshot`;
    if (!isLaunchCandidate(p)) return `${r.slug} is a bridged, staked or exchange product but ranked`;
    if (r.on_watchlist !== watch.has(r.slug)) return `${r.slug} has a wrong on_watchlist flag`;
    if (!Number.isInteger(r.tvl_rank) || r.tvl_rank < 1 || r.tvl_rank > board.length) return `${r.slug} has a bad tvl_rank`;
    if (!Number.isInteger(r.category_rank) || r.category_rank < 1 || r.category_rank > r.category_size) return `${r.slug} has a bad category_rank`;
    if (!Array.isArray(r.farm_steps) || r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps?.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = String(s).trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has farm step length ${t.length}`;
      if (!/Cost:\s*\S/.test(t) || !/Time:\s*\S/.test(t)) return `${r.slug} has a farm step without Cost or Time`;
    }
  }
  const missingWatch = snapshot.watchlist.filter((w) => !board.some((r) => r.slug === w));
  if (missingWatch.length > 0) return `screen dropped ${missingWatch.length} watchlist slugs: ${missingWatch.slice(0, 3).join(', ')}`;
  return null;
}

export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
