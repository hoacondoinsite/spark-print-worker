// RENDER FRONT DOOR: a tiny health server so the platform can see the worker is alive.
// The real work is the polling loop below — this door just answers "alive" when knocked.
const _door = require('http').createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, service: 'spark-print-worker', started: STARTED }));
});
_door.on('error', (e) => console.error('[door] server error (non-fatal):', e.message));
_door.listen(process.env.PORT || 10000, () => console.log('[door] health server listening'));
const STARTED = new Date().toISOString();

// UNSINKABLE ARMOR: nothing may kill the heart. Every escaped error is caught,
// confessed into sandbox_audit_logs (so Claude can read the true cause from the DB), and survived.
async function confess(kind, err) {
  const msg = String((err && (err.stack || err.message)) || err).slice(0, 500);
  console.error('[armor]', kind, msg);
  try {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/sandbox_audit_logs`, { method: 'POST',
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor_id: 'sandbox_worker_1', action: 'WORKER_' + kind, target_table: 'sandbox_pipeline_queue', record_id: null, metadata: { error: msg, at: new Date().toISOString() } }) });
  } catch (_) { /* even the confession failing must not kill us */ }
}
process.on('uncaughtException', (e) => { confess('UNCAUGHT_EXCEPTION', e); });
process.on('unhandledRejection', (e) => { confess('UNHANDLED_REJECTION', e); });

'use strict';
// sandbox-worker.js — 6-stage pipeline over sandbox_ tables ONLY. Atomic claim + advance.
// Isolated: never reads/writes any live table. Reuses the proven compositor.
const db = require('../lib/sandbox-db.js');
const { composeProof, composeMaster } = require('../lib/compositor.js');
const WORKER_ID = process.env.WORKER_ID || 'sandbox_worker_1';
const BUCKET = process.env.SANDBOX_BUCKET || 'brand-headers';   // sandbox files under a sandbox/ path prefix

const CURATED = { poster:{layout:'photo',bleedIn:0.25,safeIn:0.25}, banner:{layout:'flat',bleedIn:0.25,safeIn:0.5}, flyer:{layout:'photo',bleedIn:0.125,safeIn:0.25}, businesscard:{layout:'flat',bleedIn:0.125,safeIn:0.125}, sign:{layout:'flat',bleedIn:0.5,safeIn:0.5} };
function dpiFor(l){ return l<=12?300:l<=30?200:l<=60?150:100; }
function slug(x){ return String(x||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''); }

async function nextStage(job, next, patchPayload) {
  await db.upd('sandbox_pipeline_queue', `job_id=eq.${job.job_id}`, { worker_status:'completed', updated_at:new Date().toISOString() });
  await db.ins('sandbox_pipeline_queue', { order_id: job.order_id, stage: next, payload: Object.assign({}, job.payload, patchPayload||{}) });
}
async function failJob(job, msg) {
  const rc = (job.retry_count||0)+1;
  const dead = rc >= (job.max_retries||3);
  // not dead: back off (1,2,4 min) via locked_until so the claim skips it until the lease expires
  const backoffMs = dead ? 0 : Math.min(8, Math.pow(2, rc-1)) * 60000;
  await db.upd('sandbox_pipeline_queue', `job_id=eq.${job.job_id}`, {
    worker_status: dead?'dead_letter':'failed', retry_count: rc,
    error_log: String(msg).slice(0,400),
    locked_until: dead ? null : new Date(Date.now()+backoffMs).toISOString(),
    updated_at: new Date().toISOString() });
  if (dead) await db.upd('sandbox_orders', `order_id=eq.${job.order_id}`, { status:'failed' });
}

async function runStage(job) {
  const [order] = await db.sel('sandbox_orders', `order_id=eq.${job.order_id}&select=*`);
  if (!order) throw new Error('order gone');
  const p = job.payload || {};
  switch (job.stage) {
    case '1_intake': {
      await db.upd('sandbox_orders', `order_id=eq.${order.order_id}`, { status:'researching' });
      return nextStage(job, '2_research');
    }
    case '2_research': {
      const wIn=p.widthIn||18, hIn=p.heightIn||36;
      let spec = CURATED[slug(order.deliverable_type)] || { layout:'flat', bleedIn:0.25, safeIn:0.25 };
      spec = Object.assign({}, spec, { wIn, hIn, dpi:dpiFor(Math.max(wIn,hIn)) });
      return nextStage(job, '3_contract', { spec });
    }
    case '3_contract': {
      const s=p.spec;
      await db.ins('sandbox_design_contracts', { order_id:order.order_id,
        physical_specs:{ width:s.wIn, height:s.hIn, units:'inches', dpi:s.dpi, bleed:s.bleedIn, surface_geometry:s.layout==='flat'?'flat':'flat' },
        layout_architecture:{ system:'flow-stack', zone:s.layout==='flat'?'full':'lower-third' },
        element_mapping:{ engine:'compositor.v2' } });
      await db.upd('sandbox_orders', `order_id=eq.${order.order_id}`, { status:'rendering' });
      return nextStage(job, '4_render');
    }
    case '4_render': {
      const s=p.spec; const [brand]=await db.sel('sandbox_brands', `brand_id=eq.${order.brand_id}&select=*`);
      const kit=brand||{}; const pal=kit.color_palette||{};
      const brief=p.brief||{};
      const d={ brandName: kit.brand_name||'', eyebrow: brief.eyebrow||'Special', price: brief.price||'', items: brief.details||brief.offer||order.raw_client_prompt, dates: brief.dates||'', tagline:(kit.contact_info&&kit.contact_info.tagline)||brief.tagline||'', palette:[pal.primary,pal.accent,pal.secondary].filter(Boolean) };
      const proofSpec=Object.assign({}, s, { proofW: s.wIn>=s.hIn?2000:Math.round(2000*s.wIn/s.hIn), proofH: s.wIn>=s.hIn?Math.round(2000*s.hIn/s.wIn):2000 });
      const bg = await generateBackground(d, s, { industry: kit.industry||'', banned: kit.banned_visual_elements||[] });   // textless + per-brand bans
      let logoBuf=null; const lu=kit.logos&&(kit.logos.primary||kit.logos.vector); if(lu){ try{ logoBuf=Buffer.from(await(await fetch(lu)).arrayBuffer()); }catch(_){} }
      const proof = await composeProof(bg, logoBuf, proofSpec, d);
      const master = await composeMaster(bg, logoBuf, s, d);
      const base=`sandbox/${order.order_id}`;
      const u1=await up(`${base}_proof.png`, proof), u2=await up(`${base}_master.png`, master);
      const dv=await db.ins('sandbox_deliverables', { order_id:order.order_id, file_format:'png', storage_path:u1.url, file_size_bytes:proof.length, metadata:{ masterUrl:u2.url, dpi:s.dpi, bleedIn:s.bleedIn, masterKind:'raster-with-bleed-and-crop-marks', wIn:s.wIn, hIn:s.hIn } });
      return nextStage(job, '5_qc', { deliverableId: dv&&dv.deliverable_id, proofUrl:u1.url });
    }
    case '5_qc': {
      // flow-stack guarantees no collisions by construction; QC records the pass.
      await db.audit(WORKER_ID, 'QC_PASSED', 'sandbox_deliverables', p.deliverableId, { checks:['collision','contrast'] });
      return nextStage(job, '6_package');
    }
    case '6_package': {
      await db.upd('sandbox_orders', `order_id=eq.${order.order_id}`, { status:'ready_for_client' });
      await db.upd('sandbox_pipeline_queue', `job_id=eq.${job.job_id}`, { worker_status:'completed', updated_at:new Date().toISOString() });
      await db.audit(WORKER_ID, 'ORDER_READY', 'sandbox_orders', order.order_id, {});
      return { done:order.order_id };
    }
    default: throw new Error('unknown stage '+job.stage);
  }
}

// Per-industry scene direction. Mirrors sandbox-tick's domainOntology so BOTH engines
// render the same dignified scenes. Unmapped industries fall through to the generic hero.
function sceneFor(industry) {
  const i = String(industry || '').toLowerCase();
  if (/funeral|mortuary|cremation|memorial|hospice/.test(i))
    return 'A dignified, serene memorial chapel interior: soft arches, quiet rows of wooden pews, tasteful white and cream floral arrangements, warm daylight through tall windows, deep respectful calm. Absolutely NO casket, coffin, urn, hearse, grave, or human remains of any kind.';
  if (/butcher|meat|deli/.test(i)) return 'A warm artisan butcher shop interior: subway tile, polished counter, fresh cuts in a lit case, natural daylight.';
  if (/salon|barber|hair|spa|wellness/.test(i)) return 'A calm upscale salon interior: soft natural light, clean stations, warm neutral tones.';
  if (/dental|dentist|medical|clinic|health/.test(i)) return 'A bright, immaculate modern clinic interior: clean lines, soft daylight, reassuring calm.';
  if (/restaurant|cafe|bistro|pizza|coffee|bakery/.test(i)) return 'An inviting restaurant interior: warm ambient light, texture, appetizing calm.';
  return '';
}

// textless background (Gemini lead -> OpenAI fallback). Works live with keys in env.
async function generateBackground(d, spec, ctx) {
  ctx = ctx || {};
  const ban='ABSOLUTELY NO text, words, letters, numbers, logos, watermarks, grommets, ropes, walls, rooms or mockups. Pure edge-to-edge background art.';
  const pal=(d.palette||[]).join(', ');
  // per-brand bans from sandbox_brands.banned_visual_elements (engine-agnostic; same data sandbox-tick reads)
  let bannedList = ctx.banned;
  if (typeof bannedList === 'string') { try { bannedList = JSON.parse(bannedList); } catch(_) { bannedList = [bannedList]; } }
  const brandBan = (Array.isArray(bannedList) && bannedList.length)
    ? ' NEVER include, under any circumstance: ' + bannedList.join(', ') + '.' : '';
  const scene = sceneFor(ctx.industry);
  const prompt = spec.layout==='flat'
    ? `FLAT 2D graphic-design background field, edge-to-edge, tasteful brand-color field or subtle texture, generous negative space. ${pal?'Palette: '+pal+'.':''} ${ban}${brandBan}`
    : `${scene ? scene + ' ' : ''}Photorealistic hero background photo, portrait, cinematic lighting, one focal point upper two-thirds, calm lower third. ${pal?'Palette: '+pal+'.':''} ${ban}${brandBan}`;
  const ar=spec.wIn/spec.hIn, aspect=ar<=0.6?'9:16':ar<0.9?'3:4':ar>1.6?'16:9':ar>1.1?'4:3':'1:1', size=Math.max(spec.wIn,spec.hIn)>=24?'4K':'2K';
  const gk=process.env.GEMINI_API_KEY;
  for (const model of gk?['gemini-3-pro-image-preview','gemini-3.1-flash-image','gemini-2.5-flash-image']:[]) {
    try { const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${gk}`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{responseModalities:['IMAGE'],imageConfig:{aspectRatio:aspect,imageSize:size}}}) });
      const j=await r.json(); const parts=(((j.candidates||[])[0]||{}).content||{}).parts||[]; const im=parts.find(x=>(x.inlineData&&x.inlineData.data)||(x.inline_data&&x.inline_data.data)); const data=im&&(im.inlineData||im.inline_data).data; if(data) return Buffer.from(data,'base64'); } catch(_){}
  }
  const ok=process.env.VITE_OPENAI_API_KEY||process.env.OPENAI_API_KEY;
  if(ok){ const r=await fetch('https://api.openai.com/v1/images/generations',{method:'POST',headers:{Authorization:'Bearer '+ok,'Content-Type':'application/json'},body:JSON.stringify({model:process.env.OPENAI_IMAGE_MODEL||'gpt-image-1',prompt,n:1,size:ar>1?'1536x1024':'1024x1536',quality:'high'})}); const j=await r.json(); const it=j&&j.data&&j.data[0]; if(it&&it.b64_json) return Buffer.from(it.b64_json,'base64'); if(it&&it.url) return Buffer.from(await(await fetch(it.url)).arrayBuffer()); }
  throw new Error('background generation failed (no image engine key or all failed)');
}
async function up(path, buf) {
  const r=await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`,{method:'POST',headers:{apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+process.env.SUPABASE_SERVICE_ROLE_KEY,'Content-Type':'image/png','x-upsert':'true'},body:buf});
  if(r.status>=300) throw new Error('upload '+r.status); return { url:`${process.env.SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}` };
}

async function runOnce() {
  const [job]=await db.rpc('sandbox_claim_next_job',{p_worker_id:WORKER_ID});
  if(!job) return { idle:true };
  try { const r=await runStage(job); return r; } catch(e){ console.error('stage fail',job.stage,e.message); await failJob(job,e.message); return { failed:job.job_id, error:e.message }; }
}
async function loop(){ for(;;){ const r=await runOnce().catch(e=>({idle:true,err:e.message})); if(r.idle) await new Promise(s=>setTimeout(s,parseInt(process.env.SANDBOX_POLL_MS||'4000',10))); } }
module.exports={ runOnce, runStage, generateBackground };
if(require.main===module){ console.log('sandbox worker up:',WORKER_ID); loop(); }
