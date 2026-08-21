// config.js — one place to read tuning knobs from, for the modules that need
// them before server.js has finished starting.
//
// These settings used to be environment variables only, read at module load.
// That put every value a benchmark record cites — hop ceiling, command timeout,
// output ceiling, stream budgets — somewhere nobody could see: `server.bat` sets
// no environment, so changing one meant editing source or setting a machine-wide
// variable. They belong in `config.json` next to the port and the workspaces.
//
// Precedence, highest first:
//   1. environment variable   — a one-off override for a single run
//   2. config.json "harness"  — the durable setting for this install
//   3. built-in default       — what the code ships with
//
// Read once at module load, like the environment variables they replace: these
// are start-up parameters, so changing one needs a restart. server.js loads the
// same file separately for its own settings and rewrites it on workspace edits;
// round-tripping the whole object keeps this block intact.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, '..', 'config.json');

let file = {};
try {
  file = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch (err) {
  // A missing config.json is normal on a fresh clone; a malformed one is not,
  // and silently falling back to defaults would hide it.
  if (err.code !== 'ENOENT') console.error(`config: ${FILE} could not be read (${err.message}) — using defaults`);
}

const harness = file.harness ?? {};

/** Numeric setting. Env wins, then config.json, then the default. */
export function num(envName, key, fallback) {
  const raw = process.env[envName] ?? harness[key];
  const n = Number(raw);
  return raw === undefined || raw === null || raw === '' || Number.isNaN(n) ? fallback : n;
}

/** String setting; null when unset so callers can run their own search order. */
export function str(envName, key, fallback = null) {
  const raw = process.env[envName] ?? harness[key];
  return raw === undefined || raw === null || raw === '' ? fallback : String(raw);
}

/**
 * Boolean setting. Env uses the wording each knob already documented — EMBER_IDENTITY=off,
 * EMBER_CRAFT=on — so accept those words as well as true/false.
 */
export function flag(envName, key, fallback) {
  const raw = process.env[envName] ?? harness[key];
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'boolean') return raw;
  const s = String(raw).toLowerCase();
  if (['off', 'false', '0', 'no'].includes(s)) return false;
  if (['on', 'true', '1', 'yes'].includes(s)) return true;
  return fallback;
}

/** Where each value came from — for the run report, so a record can be audited. */
export function origin(envName, key) {
  if (process.env[envName] !== undefined && process.env[envName] !== '') return 'env';
  if (harness[key] !== undefined && harness[key] !== null && harness[key] !== '') return 'config.json';
  return 'default';
}
