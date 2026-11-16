# Token Launch Radar

A ranked radar of pre-token DeFi protocols built from a sealed DefiLlama snapshot. It scores each protocol by an implied value of an eventual token launch using only the snapshot's own figures (TVL, 7-day change, and time tracked without a token), derives category valuation multiples from live token-bearing peers in the same snapshot, and produces a concrete farm plan for every ranked protocol.

## Run

```bash
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
```

Outputs are written to `out/`: `board.json`, `data.js`, `dashboard/`, `screenshots/`, and `dossier.json`.

## Badges

[![token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/VUXXE/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/VUXXE/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01)
