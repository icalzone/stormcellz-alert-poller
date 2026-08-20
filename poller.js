'use strict';

/**
 * StormCellz NWS Alert Poller
 *
 * Runs on a GitHub Actions schedule (see .github/workflows/poll.yml). Fetches every
 * currently active NWS alert in one call, collapses updates of the same hazard using a
 * stable VTEC-derived key, and sends exactly one FCM topic push per (zone, tier) for each
 * newly-seen, non-cancelled hazard. When a previously-notified hazard is cancelled/expired,
 * sends a silent "clear" push so the client can retract the delivered banner.
 *
 * Topic naming matches the iOS client (FCMService.swift):
 *   nws_{UGC_zone}_{tier}   e.g. nws_MEZ017_severe
 * Severity tiers: minor | moderate | severe | extreme (AlertSeverityThreshold.swift raw values).
 *
 * No server-side device registry — a device subscribes directly to the zone+tier topics it
 * cares about (see the app's FCMService.swift). This script never knows or needs to know who
 * is listening; Firebase handles fan-out. That's what keeps this free regardless of user count.
 *
 * Dedup state lives in state/seen-hazards.json, committed back to this repo by the workflow
 * after each run (see README.md for why a committed file was chosen over Actions cache).
 */

const fs = require('fs');
const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

const STATE_PATH = path.join(__dirname, 'state', 'seen-hazards.json');
const NWS_URL = 'https://api.weather.gov/alerts/active?status=actual&message_type=alert,update';
const GRACE_MS = 6 * 60 * 60 * 1000; // keep a seen hazard's state for 6h past its end, then clear+prune

// ─────────────────────────────────────────────────────────────────
// Firebase init
// ─────────────────────────────────────────────────────────────────

function initFirebase() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env var is missing');
  const creds = JSON.parse(raw);
  initializeApp({ credential: cert(creds) });
}

// ─────────────────────────────────────────────────────────────────
// State file
// ─────────────────────────────────────────────────────────────────

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

// ─────────────────────────────────────────────────────────────────
// NWS parsing helpers (ported from the original checkNWSAlerts Cloud Function,
// see git history: 187079c^:functions/index.js — logic unchanged, only the
// Firestore-backed dedup/targeting was replaced with the state file + topic sends below)
// ─────────────────────────────────────────────────────────────────

/** Map NWS severity string → our topic tier, or null to skip unknown values. */
function nwsSeverityToTier(severity) {
  switch ((severity ?? '').toLowerCase()) {
    case 'extreme':  return 'extreme';
    case 'severe':   return 'severe';
    case 'moderate': return 'moderate';
    case 'minor':    return 'minor';
    case 'unknown':  return 'minor';
    default:         return null;
  }
}

/** Interruption level for an alert tier — severe/extreme break through Focus/DND. */
function interruptionLevelForTier(tier) {
  return (tier === 'extreme' || tier === 'severe') ? 'time-sensitive' : 'active';
}

/**
 * Stable per-hazard key so updates to the same hazard neither re-notify nor stack.
 * Prefers the NWS VTEC event-tracking number (office + phenomenon + significance + ETN),
 * which is constant across NEW/CON/UPG updates; falls back to the sanitized alert id.
 * Example VTEC: /O.NEW.KOUN.SV.W.0035.250101T2100Z-250101T2200Z/
 */
function hazardKeyFor(props, id) {
  const vtecRaw = props?.parameters?.VTEC;
  const vtec = Array.isArray(vtecRaw) ? vtecRaw[0] : vtecRaw;
  if (vtec) {
    const parts = String(vtec).split('.');
    if (parts.length >= 6) {
      const office = parts[2];
      const phenom = parts[3];
      const signif = parts[4];
      const etn    = parts[5].split('-')[0].replace(/[^0-9]/g, '');
      if (office && phenom && signif && etn) {
        return `vtec_${office}_${phenom}_${signif}_${etn}`;
      }
    }
  }
  return `id_${encodeAlertId(id)}`;
}

/** True when the alert's VTEC action explicitly cancels/expires the hazard. */
function isCancelVTEC(props) {
  const vtecRaw = props?.parameters?.VTEC;
  const vtec = Array.isArray(vtecRaw) ? vtecRaw[0] : vtecRaw;
  if (!vtec) return false;
  const action = String(vtec).split('.')[1]; // NEW | CON | CAN | EXP | UPG | EXT ...
  return action === 'CAN' || action === 'EXP';
}

/**
 * Encode an NWS alert ID (a URL) into a filesystem/JSON-key-safe string.
 * NWS IDs look like: https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0...
 */
function encodeAlertId(id) {
  return id
    .replace(/^.*\//, '')            // strip URL prefix, keep the urn part
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .substring(0, 500);
}

// ─────────────────────────────────────────────────────────────────
// FCM send
// ─────────────────────────────────────────────────────────────────

/**
 * Send one FCM topic message. `clear === true` sends a silent data-only push (no
 * `notification` block) that the client uses to retract an already-delivered banner.
 * The same `collapseId` (the hazard key) is used across every zone this hazard touches so
 * APNs coalesces pending duplicates for a device subscribed to more than one of them.
 */
async function sendToTopic(messaging, topic, { title, body, data, collapseId, interruptionLevel, clear }) {
  const aps = clear
    ? { 'content-available': 1 }
    : {
        alert: { title, body },
        sound: 'default',
        'content-available': 1,
        'interruption-level': interruptionLevel || 'active',
      };
  const headers = collapseId ? { 'apns-collapse-id': collapseId } : {};
  if (clear) {
    // Silent/data-only pushes need an explicit background push-type + priority 5, or APNs
    // can deprioritize/drop them — verified against a real device (2026-08-20): without
    // these headers the clear push still sent successfully but delivery to background-
    // notification handling isn't guaranteed without them per Apple's docs.
    headers['apns-push-type'] = 'background';
    headers['apns-priority'] = '5';
  }
  const message = {
    topic,
    data,
    apns: {
      headers,
      payload: { aps },
    },
    android: { priority: 'high', notification: { channelId: 'weather_alerts' } },
  };
  if (!clear) message.notification = { title, body };

  try {
    await messaging.send(message);
    return true;
  } catch (err) {
    // No subscribers for this topic is expected and fine — not every zone has a listener.
    if (err.code !== 'messaging/invalid-argument' && !err.message?.includes('no token')) {
      console.warn(`FCM send failed (topic=${topic}):`, err.message);
    }
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────

async function main() {
  initFirebase();
  const messaging = getMessaging();
  const now = Date.now();

  // ── 1. Fetch every currently active NWS alert in one call ──────
  const res = await fetch(NWS_URL, {
    headers: {
      'User-Agent': 'StormCellz/1.0 (calvin@ells-family.com)',
      Accept: 'application/geo+json',
    },
  });
  if (!res.ok) {
    console.error('NWS API error:', res.status, res.statusText);
    process.exit(1);
  }
  const json = await res.json();
  const features = json.features ?? [];
  console.log(`NWS active alerts: ${features.length}`);

  // ── 2. Index incoming alerts by stable hazard key ───────────────
  // Collapses repeated/updated NWS entries for the same hazard into one record so we
  // notify exactly once per hazard, not once per raw feed entry.
  const hazards = new Map(); // hazardKey -> { id, tier, title, body, zones, endsAtMs, expireAtMs, cancelled }
  for (const feature of features) {
    const id = feature.id;
    if (!id) continue;

    const props = feature.properties ?? {};
    const tier = nwsSeverityToTier(props.severity);
    if (!tier) continue;

    const ugcCodes = props.geocode?.UGC ?? [];
    if (ugcCodes.length === 0) continue;

    const key = hazardKeyFor(props, id);

    const endsRaw   = props.ends ?? props.expires ?? null;
    const endsAtMs  = endsRaw ? new Date(endsRaw).getTime() : now + 24 * 60 * 60 * 1000;
    const cancelled = isCancelVTEC(props) || endsAtMs <= now;

    const existing = hazards.get(key);
    if (!existing) {
      hazards.set(key, {
        id, tier,
        title: props.event ?? 'Weather Alert',
        body: props.headline ?? ((props.description ?? '').substring(0, 140).trim() || (props.event ?? 'Weather Alert')),
        zones: [...new Set(ugcCodes)],
        endsAtMs, cancelled,
      });
    } else {
      existing.zones = [...new Set([...existing.zones, ...ugcCodes])];
      existing.cancelled = existing.cancelled || cancelled;
      if (endsAtMs >= existing.endsAtMs) {
        existing.endsAtMs = endsAtMs;
        existing.tier = tier;
        existing.title = props.event ?? existing.title;
      }
    }
  }

  // ── 3. Load dedup state ─────────────────────────────────────────
  const state = loadState();

  // ── 4. Notify new, non-cancelled hazards ────────────────────────
  let notified = 0;
  for (const [key, h] of hazards) {
    if (h.cancelled) continue;   // handled by the clear pass below
    if (state[key]) continue;    // already notified this hazard

    const data = {
      type: 'weather_alert',
      hazardKey: key,
      alertId: h.id,
      severity: h.tier,
      event: h.title,
      zones: h.zones.join(','),
      endsAtMs: String(h.endsAtMs),
    };
    let anySent = false;
    for (const zone of h.zones) {
      const sent = await sendToTopic(messaging, `nws_${zone}_${h.tier}`, {
        title: h.title,
        body: h.body,
        data,
        collapseId: key,
        interruptionLevel: interruptionLevelForTier(h.tier),
      });
      anySent = anySent || sent;
    }
    state[key] = {
      tier: h.tier,
      zones: h.zones,
      endsAtMs: h.endsAtMs,
      expireAtMs: h.endsAtMs + GRACE_MS,
    };
    if (anySent) notified++;
  }

  // ── 5. Clear pass ────────────────────────────────────────────────
  // (a) Hazards explicitly cancelled/ended this cycle that we'd previously notified.
  const clearTargets = new Map(); // hazardKey -> { zones, tier }
  for (const [key, h] of hazards) {
    if (h.cancelled && state[key]) {
      clearTargets.set(key, { zones: state[key].zones ?? h.zones, tier: state[key].tier ?? h.tier });
    }
  }
  // (b) Stale state entries whose grace period has passed, independent of the current feed
  //     (covers a hazard that simply stopped appearing in the feed at all).
  for (const [key, s] of Object.entries(state)) {
    if (s.expireAtMs < now && !clearTargets.has(key)) {
      clearTargets.set(key, { zones: s.zones ?? [], tier: s.tier ?? 'minor' });
    }
  }

  let cleared = 0;
  for (const [key, t] of clearTargets) {
    for (const zone of t.zones) {
      await sendToTopic(messaging, `nws_${zone}_${t.tier}`, {
        data: { type: 'clear_alert', hazardKey: key },
        collapseId: key,
        clear: true,
      });
    }
    delete state[key];
    cleared++;
  }

  // ── 6. Persist state ─────────────────────────────────────────────
  saveState(state);

  console.log(`Done — notified ${notified} new hazard(s), cleared ${cleared} hazard(s).`);
}

main().catch(err => {
  console.error('Poller run failed:', err);
  process.exit(1);
});
