'use strict';

// Same shape as fff.nvim's frecency tracker, which the Neovim config uses:
// every visit decays with a 10-day half-life, visits older than 30 days are
// ignored, and a URL visited very often grows only logarithmically past 10.

const DECAY_CONSTANT = 0.0693; // ln(2) / 10
const SECONDS_PER_DAY = 86400;
const MAX_HISTORY_DAYS = 30;
const MAX_TIMESTAMPS = 128;

const DAY_MS = SECONDS_PER_DAY * 1000;

/** Drop visits older than the window and keep only the newest ones. */
function trimVisits(visits, now = Date.now()) {
  const cutoff = now - MAX_HISTORY_DAYS * DAY_MS;
  const fresh = visits
    .filter((time) => Number.isFinite(time) && time >= cutoff && time <= now)
    .sort((a, b) => a - b);
  return fresh.length > MAX_TIMESTAMPS ? fresh.slice(-MAX_TIMESTAMPS) : fresh;
}

/** 0 when never visited; ~1 per visit today; halves every 10 days. */
function frecency(visits, now = Date.now()) {
  let total = 0;
  for (const time of visits) {
    const age = (now - time) / DAY_MS;
    if (age < 0 || age > MAX_HISTORY_DAYS) continue;
    total += Math.exp(-DECAY_CONSTANT * age);
  }
  if (total <= 10) return Math.round(total);
  return Math.round(10 + Math.sqrt(total - 10));
}

module.exports = { frecency, trimVisits, MAX_HISTORY_DAYS, MAX_TIMESTAMPS };
