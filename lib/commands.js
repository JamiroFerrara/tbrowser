'use strict';

const ALLOWED_SCHEMES = new Set(['http', 'https', 'file', 'about']);
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;

function looksLikeUrl(input) {
  if (/\s/.test(input)) return false;

  const scheme = SCHEME_RE.exec(input);
  if (scheme) {
    // localhost:3000 / example.com:8080 look like schemes but are hosts.
    const rest = input.slice(scheme[0].length);
    return /^\d+(\/|$)/.test(rest);
  }

  if (input.startsWith('localhost')) return true;
  return input.includes('.');
}

function schemeFor(input) {
  const hostPort = input.split(/[/?#]/)[0];
  const port = /:(\d+)$/.exec(hostPort)?.[1];
  const host = hostPort.replace(/:\d+$/, '');
  if (host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return 'http';
  if (port && port !== '443') return 'http';
  return 'https';
}

/**
 * Turn raw command-bar text into a URL.
 * Allowed schemes pass through, host-looking text gets a scheme,
 * everything else becomes a search.
 */
function parseInput(raw, searchUrl = 'https://duckduckgo.com/?q=') {
  const input = String(raw ?? '').trim();
  if (!input) return null;

  const scheme = SCHEME_RE.exec(input);
  if (scheme && ALLOWED_SCHEMES.has(scheme[1].toLowerCase())) return input;

  if (looksLikeUrl(input)) return `${schemeFor(input)}://${input}`;

  return `${searchUrl}${encodeURIComponent(input)}`;
}

/** ":extensions" -> { name: "extensions", args: [] }. */
function parseCommand(raw) {
  const text = String(raw ?? '').trim();
  if (!text.startsWith(':')) return null;
  const body = text.slice(1).trim();
  if (!body) return { name: '', args: [] };
  const [name, ...args] = body.split(/\s+/);
  return { name: name.toLowerCase(), args };
}

module.exports = { parseInput, parseCommand, looksLikeUrl, schemeFor };
