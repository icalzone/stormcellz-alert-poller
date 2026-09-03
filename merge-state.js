#!/usr/bin/env node
//
// Unions the committed dedup state with this run's working copy.
//
// Both sides legitimately add hazards — the committed file carries what previous runs
// notified, the working copy carries what this run has notified since it checked out — so
// asking git to merge them textually produces a conflict, and a conflicted file is invalid
// JSON. `loadState` refuses to read that, which stalls the poller; before 2026-09-03 it
// silently returned an empty state instead and re-notified every active hazard.
//
// A union is the correct merge: a key present on either side means that hazard has been
// notified and must not be sent again. The local entry wins a collision because it is the
// newer observation of the same hazard. Entries the local side has pruned but the remote
// still holds are resurrected here and pruned again on the next poll by the normal grace
// logic, so the union is self-correcting rather than unbounded.
//
// Usage: node merge-state.js <remote.json> <local.json>   (writes the union to <local.json>)

const fs = require('fs');

const [remotePath, localPath] = process.argv.slice(2);
if (!remotePath || !localPath) {
  console.error('usage: node merge-state.js <remote.json> <local.json>');
  process.exit(2);
}

function readObject(file, label) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (raw === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`merge-state: ${label} (${file}) is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error(`merge-state: ${label} (${file}) is not a JSON object`);
    process.exit(1);
  }
  return parsed;
}

const remote = readObject(remotePath, 'remote state');
const local  = readObject(localPath, 'local state');

const merged = { ...remote, ...local };

const added = Object.keys(remote).filter((k) => !(k in local)).length;
const tmp = `${localPath}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n');
fs.renameSync(tmp, localPath);

console.log(
  `merge-state: ${Object.keys(local).length} local + ${Object.keys(remote).length} remote ` +
  `-> ${Object.keys(merged).length} (${added} recovered from remote)`
);
