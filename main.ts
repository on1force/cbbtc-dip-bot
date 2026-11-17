// cbBTC mean-reversion bot for agent-fun/bars-replay/v1, long only.
//
// The dev window is choppy: 1-minute trend followers bleed fees there, while stretched dips revert.
// So the bot waits for a deep dip, buys it, and sells the bounce:
//   - Signal: z = (close - mean) / sd over the last LOOKBACK closes (the symbol's own bars; a gap
//     adds nothing). Float64 on + - * / and sqrt only, so the same bars give the same orders.
//   - Entry: flat and z < -ENTRY_Z: spend all cash (one position, 100% weight is allowed).
//   - Exit, the whole position: z > EXIT_Z (the bounce), the close STOP_BPS under the entry fill
//     price (the dip turned into a trend), or MAX_HOLD bars held. A sell the market refuses is sent
//     again on the next bar while its reason still holds.
//   - Guardrail: the race needs at least one filled trade of its own. If the bot has filled nothing
//     by INSURANCE_SEQ, it buys MIN_TICKET once and sells it on the next bar, a cost of cents.

import { BPS, runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const LOOKBACK = 240;
const ENTRY_Z = 2.5;
const EXIT_Z = 1.0;
const STOP_BPS = 150n;
const MAX_HOLD = 480;
const MAX_SLIPPAGE_BPS = 100;
const INSURANCE_SEQ = 1380;
const MIN_TICKET = 2_000_000n;

const closes: number[] = [];
let entryPrice = 0;
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
  const close = closes[closes.length - 1];
  const held = state.positions.get(SYMBOL);
  const z = zscore();

  if (held !== undefined && held.qty > 0n) {
    heldBars++;
    const stopped = close * Number(BPS) < entryPrice * Number(BPS - STOP_BPS);
    const bounced = z !== null && z > EXIT_Z;
    if (bounced || stopped || heldBars >= MAX_HOLD || insured) {
      return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  }

  const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
  if (z !== null && z < -ENTRY_Z && state.cash >= minNotional) {
    heldBars = 0;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
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
      if (fill.side === 'buy') entryPrice = Number(fill.price);
      else insured = false;
    }
    let fresh = false;
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      closes.push(Number(bar.c));
      fresh = true;
    }
    if (closes.length > LOOKBACK) closes.shift();
    if (state.warmingUp || !fresh) return [];
    return decide(state, batch.seq);
  },
});
