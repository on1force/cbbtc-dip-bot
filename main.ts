// cbBTC mean-reversion bot for agent-fun/bars-replay/v1, long only.
//
// The dev window is choppy: 1-minute trend followers bleed fees there, while stretched dips revert.
// So the bot waits for a deep dip, buys it in two halves, and sells the bounce:
//   - Signal: z = (close - mean) / sd over the last LOOKBACK closes (the symbol's own bars; a gap
//     adds nothing). Float64 on + - * / and sqrt only, so the same bars give the same orders.
//   - Arm: flat and z < -ENTRY_Z. Entry: armed, the close above the one before (the first up-bar,
//     so it does not catch a falling knife) and z still under 0. It buys half its cash.
//   - Add: holding the first half and z < -ADD_Z: it buys the other half, lower.
//   - Exit, the whole position: z > EXIT_Z (the bounce), the position STOP_BPS under its cost,
//     fees included (the dip turned into a trend), or MAX_HOLD bars held. A sell the market refuses
//     is sent again on the next bar while its reason still holds.
//   - Guardrail: the race needs at least one filled trade of its own. If the bot has filled nothing
//     by INSURANCE_SEQ, it buys MIN_TICKET once and sells it on the next bar, a cost of cents.
//
// Picked on the dev window and on 100 block-shuffled copies of it: the halves plus the first up-bar
// made money on 71 of the copies where a single all-in buy on the dip made it on 56.

import { BPS, runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const LOOKBACK = 240;
const ENTRY_Z = 2.5;
const ADD_Z = 3.25;
const EXIT_Z = 1.5;
const STOP_BPS = 200n;
const MAX_HOLD = 480;
const MAX_SLIPPAGE_BPS = 100;
const INSURANCE_SEQ = 1380;
const MIN_TICKET = 2_000_000n;

const closes: number[] = [];
let armed = false;
let added = false;
let heldBars = 0;
let filled = 0;
let insured = false;

function zscore(): number | null {
  if (closes.length < LOOKBACK) return null;
  let sum = 0;
  for (let i = closes.length - LOOKBACK; i < closes.length; i++) sum += closes[i];
  const mean = sum / LOOKBACK;
  let sq = 0;
  for (let i = closes.length - LOOKBACK; i < closes.length; i++) sq += (closes[i] - mean) * (closes[i] - mean);
  const sd = Math.sqrt(sq / LOOKBACK);
  if (sd === 0) return null;
  return (closes[closes.length - 1] - mean) / sd;
}

function decide(state: BarsState, seq: number): OrderInput[] {
  const held = state.positions.get(SYMBOL);
  const z = zscore();
  const minNotional = BigInt(state.hello.fees.min_notional_quote_units);

  if (held !== undefined && held.qty > 0n) {
    heldBars++;
    if (insured) return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    if (z === null) return [];
    const stopped = state.value(SYMBOL, held.qty) * BPS < held.cost * (BPS - STOP_BPS);
    if (z > EXIT_Z || stopped || heldBars >= MAX_HOLD) {
      armed = false;
      return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    if (!added && z < -ADD_Z && state.cash >= minNotional) {
      added = true;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  }

  if (z !== null) {
    const upBar = closes[closes.length - 1] > closes[closes.length - 2];
    let go = false;
    if (z < -ENTRY_Z) {
      armed = true;
      go = upBar;
    } else {
      go = armed && upBar && z < 0;
      if (z >= 0) armed = false;
    }
    const half = state.cash / 2n;
    if (go && half >= minNotional) {
      armed = false;
      added = false;
      heldBars = 0;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: half, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
  }
  if (filled === 0 && !insured && seq >= INSURANCE_SEQ && state.cash >= MIN_TICKET) {
    insured = true;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: MIN_TICKET, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }
  return [];
}

await runBars({
  onBatch(state, batch) {
    for (const fill of batch.fills) {
      if (fill.status !== 'filled') continue;
      filled++;
      if (fill.side === 'sell') insured = false;
    }
    let fresh = false;
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      closes.push(Number(bar.c));
      fresh = true;
    }
    if (closes.length > LOOKBACK + 1) closes.shift();
    if (state.warmingUp || !fresh) return [];
    return decide(state, batch.seq);
  },
});
