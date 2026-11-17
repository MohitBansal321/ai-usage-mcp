#!/usr/bin/env node
/**
 * Renders assets/report.svg, the terminal picture at the top of the README.
 *
 * The text is the real output format of `npx ai-usage-mcp` started from a
 * terminal, with session titles, branches and ids replaced by sample ones.
 * When the report's format changes, update SAMPLE below to match what the
 * command prints and re-run: `node scripts/render-readme-image.mjs`.
 * SVG rather than a screenshot so it stays sharp and diffs as text.
 */
import { writeFileSync, mkdirSync } from 'node:fs';

const SAMPLE = `$ npx ai-usage-mcp

Usage report -- last 7 days (local time)

598 turns across 12 sessions, 88,006,221 (88.01M) tokens.
Verdict: Some waste -- a noticeable share of this usage re-read or rebuilt old context.

Where it went (share of usage, weighted by API-equivalent price):
   12.3%  re-reading context above 100k tokens (327 turns; largest context 408,319 (408.3K))
   16.0%  rebuilding a lost cache (10 times, 5 after an idle break)
   28.3%  total -- avoidable in part, not whole

What to change:
  1. Compact earlier. 3 session(s) grew past 200k tokens of context (largest: "Payments
     refactor", 408k). Run /compact once a session passes ~100k.
  2. Don't resume a session that has gone cold. 5 time(s) a session was continued after its
     prompt cache expired, and the whole context was re-written from scratch.
  3. Keep the start of a session stable. 5 cache rebuild(s) happened without an idle gap --
     usually a model switch mid-session, or editing CLAUDE.md while a session is running.

Heaviest sessions:
   39.2%  Fix flaky checkout tests  [fix/checkout-retry, claude-code]
          165 turns, peak context 319,570 (319.6K), 2 cache rebuild(s)
   28.8%  Payments refactor  [main, claude-code]
          257 turns, peak context 408,319 (408.3K), 5 cache rebuild(s)
    8.8%  Admin list view  [feat/admin-list, codex]
          48 turns, peak context 166,367 (166.4K), 0 cache rebuild(s)

Weight: $34.81 API-equivalent across 489 turns. On a subscription that is not money spent.`;

const FONT_SIZE = 14;
const LINE = 20;
// Advance width of a 14px monospace cell, rounded up: viewers fall back to
// different fonts, and a wider one must not clip the longest line.
const CHAR = 8.8;
const PAD_X = 24;
const TOP = 52;

const lines = SAMPLE.split('\n');
const cols = Math.max(...lines.map((l) => l.length));
const width = Math.ceil(PAD_X * 2 + cols * CHAR);
const height = TOP + lines.length * LINE + 20;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function classFor(line) {
  if (line.startsWith('$ ')) return 'cmd';
  if (/^(Usage report|Where it went|What to change|Heaviest sessions)/.test(line)) return 'head';
  if (line.startsWith('Verdict:')) return 'verdict';
  if (/^\s+\d+\.\d+%/.test(line)) return 'pct';
  if (line.startsWith('Weight:')) return 'dim';
  return '';
}

function render(line, y) {
  const cls = classFor(line);
  // Keep the leading percentage in the accent colour and the rest plain.
  const m = cls === 'pct' ? /^(\s+\d+\.\d+%)(.*)$/.exec(line) : null;
  const body = m ? `<tspan class="pct">${esc(m[1])}</tspan>${esc(m[2])}` : esc(line);
  return `<text x="${PAD_X}" y="${y}"${cls && !m ? ` class="${cls}"` : ''} xml:space="preserve">${body}</text>`;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Output of npx ai-usage-mcp: a 7-day usage report showing where tokens went, what to change, and the heaviest sessions">
  <style>
    text { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace; font-size: ${FONT_SIZE}px; fill: #d4d4d8; }
    .cmd { fill: #86efac; }
    .head { fill: #fafafa; font-weight: 700; }
    .verdict { fill: #fcd34d; }
    .pct { fill: #7dd3fc; }
    .dim { fill: #a1a1aa; }
  </style>
  <rect width="${width}" height="${height}" rx="10" fill="#18181b"/>
  <circle cx="22" cy="20" r="6" fill="#f87171"/>
  <circle cx="42" cy="20" r="6" fill="#fbbf24"/>
  <circle cx="62" cy="20" r="6" fill="#4ade80"/>
  ${lines.map((l, i) => render(l, TOP + i * LINE)).join('\n  ')}
</svg>
`;

mkdirSync('assets', { recursive: true });
writeFileSync('assets/report.svg', svg);
console.log(`assets/report.svg: ${width}x${height}, ${lines.length} lines`);
