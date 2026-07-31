'use strict';
// compositor.js v2 — editorial, agency-grade layout. node-canvas (server-side).
const { createCanvas, loadImage, registerFont } = require('canvas');
try {
  registerFont(require('path').join(__dirname,'..','fonts','PlayfairDisplay.ttf'), { family: 'Playfair Display', weight: '700' });
  registerFont(require('path').join(__dirname,'..','fonts','Inter.ttf'), { family: 'Inter' });
} catch (e) {}

// refined warm defaults (overridden by brand palette when present)
const DEF = { ink: '#16100A', gold: '#C79A4B', cream: '#F1E8D6', mute: 'rgba(241,232,214,0.68)' };

function hexToRgb(h){h=String(h||'').replace('#','');if(h.length===3)h=h.split('').map(c=>c+c).join('');const n=parseInt(h,16);return h.length===6?{r:(n>>16)&255,g:(n>>8)&255,b:n&255}:null;}
function lum(h){const c=hexToRgb(h);return c?(0.299*c.r+0.587*c.g+0.114*c.b):128;}
function darken(h,f){const c=hexToRgb(h);if(!c)return DEF.ink;return `rgb(${Math.round(c.r*f)},${Math.round(c.g*f)},${Math.round(c.b*f)})`;}
// choose harmonized ink/accent/cream from the brand palette
function palette(colors){
  if(!Array.isArray(colors)||!colors.length) return DEF;
  const sorted=[...colors].filter(hexToRgb).sort((a,b)=>lum(a)-lum(b));
  if(!sorted.length) return DEF;
  const ink=darken(sorted[0],0.55);
  // accent = a mid/high-chroma warm color (prefer a non-dark, non-white one)
  const accent=sorted.find(c=>{const l=lum(c);return l>70&&l<210;})||sorted[Math.floor(sorted.length/2)]||DEF.gold;
  return { ink, gold:accent, cream:DEF.cream, mute:'rgba(241,232,214,0.66)' };
}

function cover(ctx,img,x,y,w,h){const ir=img.width/img.height,r=w/h;let dw,dh,dx,dy;if(ir>r){dh=h;dw=h*ir;dx=x-(dw-w)/2;dy=y;}else{dw=w;dh=w/ir;dx=x;dy=y-(dh-h)/2;}ctx.drawImage(img,dx,dy,dw,dh);}
function tracked(ctx,t,x,base,sp){let cx=x;for(const ch of String(t)){ctx.fillText(ch,cx,base);cx+=ctx.measureText(ch).width+sp;}return cx;}
function wrap(ctx,t,font,maxW){ctx.font=font;const ws=String(t).split(/\s+/);const L=[];let ln='';for(const w of ws){const tt=ln?ln+' '+w:w;if(ctx.measureText(tt).width>maxW&&ln){L.push(ln);ln=w;}else ln=tt;}if(ln)L.push(ln);return L;}

// Editorial branding on a SOLID panel. Left-aligned, grid, grouped rhythm.
function drawBranding(ctx, W, H, panelTop, d, logo, C) {
  C = C || DEF;
  const S = W;
  // solid panel + hairline (no muddy gradient)
  ctx.fillStyle = C.ink; ctx.fillRect(0, panelTop, W, H - panelTop);
  ctx.fillStyle = C.gold; ctx.fillRect(0, panelTop, W, Math.max(3, S * 0.004));
  const ML = Math.round(S * 0.092), maxW = W - ML * 2;
  let y = panelTop + Math.round(S * 0.085);

  // logo (optional) small, left
  if (logo) { const lw = S * 0.20, lh = lw * (logo.height / logo.width); ctx.drawImage(logo, ML, y, lw, lh); y += lh + S * 0.045; }

  // eyebrow — tracked caps, gold
  if (d.eyebrow) { ctx.fillStyle = C.gold; ctx.font = `600 ${Math.round(S * 0.026)}px Inter`; tracked(ctx, d.eyebrow.toUpperCase(), ML, y, S * 0.006); y += S * 0.05; }
  // brand name — Playfair, cream (identity)
  ctx.fillStyle = C.cream; let ns = Math.round(S * 0.072); ctx.font = `700 ${ns}px "Playfair Display"`;
  while (ctx.measureText(d.brandName).width > maxW && ns > 30) { ns -= 3; ctx.font = `700 ${ns}px "Playfair Display"`; }
  ctx.fillText(d.brandName, ML, y + ns * 0.72); y += ns + S * 0.058;

  // OFFER group — price focal in Playfair (elegant, not a heavy display face)
  if (d.price) {
    const pz = Math.round(S * 0.135); ctx.fillStyle = C.gold; ctx.font = `700 ${pz}px "Playfair Display"`;
    ctx.fillText(d.price, ML, y + pz * 0.74);
    const pw = ctx.measureText(d.price).width;
    ctx.fillStyle = C.mute; ctx.font = `500 ${Math.round(S * 0.026)}px Inter`;
    ctx.fillText('+ tax', ML + pw + S * 0.02, y + pz * 0.62);
    y += pz + S * 0.03;
  }
  // items — Inter, cream, comfortable line height (max 3 lines)
  if (d.items) {
    const f = `400 ${Math.round(S * 0.0285)}px Inter`; const lines = wrap(ctx, d.items, f, maxW).slice(0, 3); const lh = S * 0.045;
    ctx.fillStyle = C.cream; ctx.font = f; lines.forEach((ln, i) => ctx.fillText(ln, ML, y + i * lh)); y += lines.length * lh + S * 0.03;
  }
  // dates — tracked caps, gold
  if (d.dates) { ctx.fillStyle = C.gold; ctx.font = `600 ${Math.round(S * 0.026)}px Inter`; tracked(ctx, d.dates.toUpperCase(), ML, y, S * 0.005); y += S * 0.055; }

  // tagline — anchored near the bottom, muted Playfair italic
  if (d.tagline) { ctx.fillStyle = C.mute; ctx.font = `italic 500 ${Math.round(S * 0.03)}px "Playfair Display"`; ctx.fillText('\u201C' + d.tagline + '\u201D', ML, H - S * 0.05); }
}

async function composeProof(bgBuffer, logoBuffer, spec, d) {
  const W = spec.proofW, H = spec.proofH;
  const cv = createCanvas(W, H), ctx = cv.getContext('2d');
  const bg = await loadImage(bgBuffer); cover(ctx, bg, 0, 0, W, H);
  const logo = logoBuffer ? await loadImage(logoBuffer).catch(() => null) : null;
  const C = palette(d.palette);
  const panelFrac = spec.layout === 'flat' ? 0.0 : 0.62;    // flat: full-panel design; photo: bottom panel
  if (spec.layout === 'flat') { drawFlat(ctx, W, H, d, logo, C, bg); }
  else drawBranding(ctx, W, H, H * panelFrac, d, logo, C);
  return cv.toBuffer('image/png');
}
async function composeMaster(bgBuffer, logoBuffer, spec, d) {
  const bleed = Math.round(spec.bleedIn * spec.dpi);
  const trimW = Math.round(spec.wIn * spec.dpi), trimH = Math.round(spec.hIn * spec.dpi);
  const W = trimW + bleed * 2, H = trimH + bleed * 2;
  const cv = createCanvas(W, H), ctx = cv.getContext('2d');
  const bg = await loadImage(bgBuffer); cover(ctx, bg, 0, 0, W, H);
  const logo = logoBuffer ? await loadImage(logoBuffer).catch(() => null) : null;
  const C = palette(d.palette);
  if (spec.layout === 'flat') drawFlat(ctx, W, H, d, logo, C, bg);
  else drawBranding(ctx, W, H, H * 0.62, d, logo, C);
  ctx.strokeStyle = '#000'; ctx.lineWidth = Math.max(2, spec.dpi * 0.01); const mk = bleed * 0.7;
  [[bleed, bleed], [W - bleed, bleed], [bleed, H - bleed], [W - bleed, H - bleed]].forEach(([x, y]) => { ctx.beginPath(); ctx.moveTo(x, y < H / 2 ? y - mk : y + mk); ctx.lineTo(x, y); ctx.moveTo(x < W / 2 ? x - mk : x + mk, y); ctx.lineTo(x, y); ctx.stroke(); });
  return cv.toBuffer('image/png');
}
// FLAT (banner/sign): full-bleed brand field, editorial left block, big offer right — restrained.
function drawFlat(ctx, W, H, d, logo, C, bg) {
  // darken the field slightly for text contrast, keep the atmosphere
  ctx.fillStyle = 'rgba(12,9,6,0.34)'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = C.gold; ctx.lineWidth = Math.max(3, W * 0.004); ctx.strokeRect(W * 0.02, H * 0.06, W - W * 0.04, H - H * 0.12);
  const ML = W * 0.055; let y = H * 0.40;
  ctx.fillStyle = C.cream; ctx.font = `700 ${Math.round(H * 0.15)}px "Playfair Display"`; ctx.fillText(d.brandName, ML, y);
  if (d.tagline) { ctx.fillStyle = C.mute; ctx.font = `italic 500 ${Math.round(H * 0.058)}px "Playfair Display"`; ctx.fillText('\u201C' + d.tagline + '\u201D', ML, y + H * 0.11); }
  const RX = W * 0.60;
  if (d.eyebrow) { ctx.fillStyle = C.gold; ctx.font = `600 ${Math.round(H * 0.05)}px Inter`; tracked(ctx, d.eyebrow.toUpperCase(), RX, H * 0.30, H * 0.02); }
  if (d.price) { ctx.fillStyle = C.cream; ctx.font = `700 ${Math.round(H * 0.26)}px "Playfair Display"`; ctx.fillText(d.price, RX, H * 0.60); const pw = ctx.measureText(d.price).width; ctx.fillStyle = C.mute; ctx.font = `500 ${Math.round(H * 0.05)}px Inter`; ctx.fillText('+ tax', RX + pw + W * 0.01, H * 0.46); }
  if (d.dates) { ctx.fillStyle = C.gold; ctx.font = `600 ${Math.round(H * 0.05)}px Inter`; tracked(ctx, d.dates.toUpperCase(), RX, H * 0.74, H * 0.015); }
}
module.exports = { composeProof, composeMaster, drawBranding, palette };
