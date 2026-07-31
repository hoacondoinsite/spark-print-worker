'use strict';
// sandbox-db.js — REST helpers for sandbox_ tables only. Isolated from live tables.
const crypto = require('crypto');
const SB_URL = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = (x) => Object.assign({ apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' }, x || {});

async function sel(t, q) { const r = await fetch(`${SB_URL}/rest/v1/${t}?${q}`, { headers: H() }); return r.ok ? r.json() : []; }
async function ins(t, row) { const r = await fetch(`${SB_URL}/rest/v1/${t}`, { method: 'POST', headers: H({ Prefer: 'return=representation' }), body: JSON.stringify(row) }); if (!r.ok) { ins.lastError = (await r.text().catch(()=>'')).slice(0,200); return null; } const j = await r.json(); return Array.isArray(j) ? j[0] : j; }
async function upd(t, q, patch) { const r = await fetch(`${SB_URL}/rest/v1/${t}?${q}`, { method: 'PATCH', headers: H(), body: JSON.stringify(patch) }); return r.ok; }
async function rpc(fn, args) { const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H(), body: JSON.stringify(args) }); const j = r.ok ? await r.json().catch(()=>[]) : []; return Array.isArray(j) ? j : []; }

// idempotency key: brand + type + normalized prompt (60s window handled by unique index + caller check)
function idemKey(brandId, type, prompt) {
  const norm = String(prompt || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(`${brandId}|${type}|${norm}`).digest('hex').slice(0, 32);
}
async function audit(actor, action, table, recordId, meta) { await ins('sandbox_audit_logs', { actor_id: actor, action, target_table: table, record_id: recordId || null, metadata: meta || {} }).catch(()=>{}); }

module.exports = { sel, ins, upd, rpc, idemKey, audit };
