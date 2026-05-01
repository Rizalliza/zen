/**
 * TRADE RESULTS REPORT GENERATOR
 *
 * Generates CSV and HTML-report-compatible JSON from myEngine simulation output.
 * Aligned with normalization pipeline (normalizer.js / poolContract.js).
 *
 * Integration in myEngine.js (end of main()):
 *   const { generateTradeReports } = require('../utilities/tradeReportGenerator');
 *   await generateTradeReports(result, options.output, {
 *     csvPath: '05_result_compare.csv',
 *     htmlJsonPath: '06_result_data.json',
 *     htmlPath: '07_result_report.html',
 *   });
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_RUNTIME_OUTPUT = '04_runtimeResults.json';
const DEFAULT_CSV_OUTPUT = '05_result_compare.csv';
const DEFAULT_JSON_OUTPUT = '06_result_data.json';
const DEFAULT_HTML_OUTPUT = '07_result_report.html';

/* -------------------------------------------------------------------------- */
/*                              DEX Type Mapping                              */
/* -------------------------------------------------------------------------- */

const CSV_DEX_ABBREV = {
  ORCA_WHIRLPOOL: 'WHIR',
  RAYDIUM_CLMM:   'CLMM',
  RAYDIUM_CPMM:   'CPMM',
  METEORA_DLMM:   'DLMM',
};

const HTML_DEX_ABBREV = {
  ORCA_WHIRLPOOL: 'WHI',
  RAYDIUM_CLMM:   'CLM',
  RAYDIUM_CPMM:   'CPM',
  METEORA_DLMM:   'DLM',
};

function getCsvDexAbbrev(dexType) {
  return CSV_DEX_ABBREV[dexType] || 'UNK';
}

function getHtmlDexAbbrev(dexType) {
  return HTML_DEX_ABBREV[dexType] || 'UNK';
}

function getDexLegName(dexType) {
  const s = String(dexType || 'UNKNOWN').toUpperCase();
  if (s.includes('WHIRLPOOL')) return 'WHIRLPOOL';
  if (s.includes('CLMM'))     return 'CLMM';
  if (s.includes('CPMM'))     return 'CPMM';
  if (s.includes('DLMM'))     return 'DLMM';
  return 'UNKNOWN';
}

/* -------------------------------------------------------------------------- */
/*                           Aggregate Computations                           */
/* -------------------------------------------------------------------------- */

function toFiniteNumber(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundTo(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(toFiniteNumber(value, 0) * factor) / factor;
}

function computeRouteAggregates(route) {
  const legs = route.legs || [];

  const sumFeeBps = legs.reduce((sum, leg) => sum + toFiniteNumber(leg.feeBps, 0), 0);

  let sumImpactBps = 0;
  for (const leg of legs) {
    if (leg.impactBps !== undefined && leg.impactBps !== null && leg.impactBps > 0) {
      sumImpactBps += toFiniteNumber(leg.impactBps, 0);
    } else if (leg.impactPct !== undefined && leg.impactPct !== null && leg.impactPct > 0) {
      sumImpactBps += toFiniteNumber(leg.impactPct, 0) * 100;
    } else if (leg.priceImpact !== undefined && leg.priceImpact !== null && leg.priceImpact > 0) {
      sumImpactBps += toFiniteNumber(leg.priceImpact, 0) * 10000;
    }
  }

  const sumTradeRatioPct = legs.reduce(
    (sum, leg) => sum + toFiniteNumber(leg.tradeRatioPct, 0), 0
  );

  const profitBps = toFiniteNumber(route.profitBps, 0);
  const grossEdgeBps = profitBps + sumFeeBps + sumImpactBps;
  const edgeMinusFeesBps = grossEdgeBps - sumFeeBps;

  return {
    sumFeeBps:        roundTo(sumFeeBps, 2),
    sumImpactBps:     roundTo(sumImpactBps, 4),
    sumTradeRatioPct: roundTo(sumTradeRatioPct, 4),
    grossEdgeBps:     roundTo(grossEdgeBps, 2),
    edgeMinusFeesBps: roundTo(edgeMinusFeesBps, 2),
  };
}

/* -------------------------------------------------------------------------- */
/*                            CSV Row Builders                                */
/* -------------------------------------------------------------------------- */

function buildRouteCsvRow(route, aggregates) {
  const legs = route.legs || [];
  const dexCombo = legs.map(l => getCsvDexAbbrev(l.dexType)).join('|');

  const inAmountSol  = toFiniteNumber(route.startAmount, 0) / 1e9;
  const outAmountSol = toFiniteNumber(route.finalAmount, 0) / 1e9;

  return {
    level:              'ROUTE',
    routeId:            route.routeId || '',
    leg:                '',
    path:               route.routePathSymbols || route.routePath || '',
    dexType:            dexCombo,
    inAmount_SOL:       inAmountSol.toFixed(1),
    outAmount_SOL:      outAmountSol.toFixed(9),
    profitLamports:     route.profitLamports || '',
    profitBps:          route.profitBps ?? '',
    sumFeeBps:          aggregates.sumFeeBps,
    sumImpactBps:       aggregates.sumImpactBps,
    sumTradeRatioPct:   aggregates.sumTradeRatioPct,
    grossEdgeBps:       aggregates.grossEdgeBps,
    edgeMinusFeesBps:   aggregates.edgeMinusFeesBps,
    feeBps:             '',
    impactBps:          '',
    tradeRatioPct:      '',
    grossImpactPct:     '',
    inSym:              '',
    outSym:             '',
    inAmount:           '',
    outAmount:          '',
    quoteSource:        '',
  };
}

function buildLegCsvRow(leg, routeId) {
  const inAmount  = toFiniteNumber(leg.inAmountRaw  || leg.inputAmount, 0);
  const outAmount = toFiniteNumber(leg.outAmountRaw || leg.expectedOutputAmount, 0);

  let impactBps = 0;
  if (leg.impactBps !== undefined && leg.impactBps !== null && leg.impactBps > 0) {
    impactBps = toFiniteNumber(leg.impactBps, 0);
  } else if (leg.impactPct !== undefined && leg.impactPct !== null && leg.impactPct > 0) {
    impactBps = toFiniteNumber(leg.impactPct, 0) * 100;
  } else if (leg.priceImpact !== undefined && leg.priceImpact !== null && leg.priceImpact > 0) {
    impactBps = toFiniteNumber(leg.priceImpact, 0) * 10000;
  }

  return {
    level:           '  leg',
    routeId:         routeId,
    leg:             leg.legIndex || '',
    path:            '',
    dexType:         getDexLegName(leg.dexType),
    inAmount_SOL:    '',
    outAmount_SOL:   '',
    profitLamports:  '',
    profitBps:       '',
    sumFeeBps:       '',
    sumImpactBps:    '',
    sumTradeRatioPct:'',
    grossEdgeBps:    '',
    edgeMinusFeesBps:'',
    feeBps:          leg.feeBps ?? '',
    impactBps:       Math.round(impactBps * 10000) / 10000,
    tradeRatioPct:   leg.tradeRatioPct ?? '',
    grossImpactPct:  leg.grossImpactPct ?? '',
    inSym:           leg.inputSymbol  || (leg.tokenInMint  ? leg.tokenInMint.slice(0, 6)  : ''),
    outSym:          leg.outputSymbol || (leg.tokenOutMint ? leg.tokenOutMint.slice(0, 6) : ''),
    inAmount:        inAmount,
    outAmount:       outAmount,
    quoteSource:     leg.quoteSource || '',
  };
}

/* -------------------------------------------------------------------------- */
/*                          HTML Report JSON Builder                          */
/* -------------------------------------------------------------------------- */

function buildHtmlReportRoute(route, aggregates) {
  const legs = route.legs || [];
  const dexCombo = legs.map(l => getHtmlDexAbbrev(l.dexType)).join('\u00b7');

  return {
    routeId:          route.routeId || '',
    path:             route.routePathSymbols || route.routePath || '',
    dexCombo,
    profitBps:        toFiniteNumber(route.profitBps, 0),
    feeBps:           aggregates.sumFeeBps,
    impactBps:        aggregates.sumImpactBps,
    tradeRatioPct:    aggregates.sumTradeRatioPct,
    grossEdgeBps:     aggregates.grossEdgeBps,
    edgeMinusFeesBps: aggregates.edgeMinusFeesBps,
    inLamports:       String(route.startAmount || '0'),
    outLamports:      String(route.finalAmount || '0'),
    profitLamports:   String(route.profitLamports || '0'),
    legs: legs.map(leg => {
      let impactBps = 0;
      if (leg.impactBps !== undefined && leg.impactBps !== null && leg.impactBps > 0) {
        impactBps = toFiniteNumber(leg.impactBps, 0);
      } else if (leg.impactPct !== undefined && leg.impactPct !== null && leg.impactPct > 0) {
        impactBps = toFiniteNumber(leg.impactPct, 0) * 100;
      } else if (leg.priceImpact !== undefined && leg.priceImpact !== null && leg.priceImpact > 0) {
        impactBps = toFiniteNumber(leg.priceImpact, 0) * 10000;
      }

      return {
        legIndex:       leg.legIndex || 0,
        dex:            getDexLegName(leg.dexType),
        inSym:          leg.inputSymbol  || (leg.tokenInMint  ? leg.tokenInMint.slice(0, 6)  : '?'),
        outSym:         leg.outputSymbol || (leg.tokenOutMint ? leg.tokenOutMint.slice(0, 6) : '?'),
        inAmount:       String(leg.inAmountRaw  || leg.inputAmount         || '0'),
        outAmount:      String(leg.outAmountRaw || leg.expectedOutputAmount || '0'),
        feeBps:         toFiniteNumber(leg.feeBps, 0),
        impactBps:      Math.round(impactBps * 10000) / 10000,
        tradeRatioPct:  toFiniteNumber(leg.tradeRatioPct, 0),
        grossImpactPct: toFiniteNumber(leg.grossImpactPct, 0),
        feePct:         toFiniteNumber(leg.feePct, 0),
        pool:           leg.poolAddress || '',
        quoteSource:    leg.quoteSource || '',
        tickStrategy:   leg.tickStrategy || null,
      };
    }),
  };
}

/* -------------------------------------------------------------------------- */
/*                            Main Export Functions                           */
/* -------------------------------------------------------------------------- */

function generateCsvFromRoutes(routes, outputPath) {
  if (!Array.isArray(routes) || routes.length === 0) {
    console.warn('[tradeReportGenerator] No routes to export to CSV');
    return null;
  }

  const csvRows = [];
  for (const route of routes) {
    const aggregates = computeRouteAggregates(route);
    csvRows.push(buildRouteCsvRow(route, aggregates));
    for (const leg of (route.legs || [])) {
      csvRows.push(buildLegCsvRow(leg, route.routeId));
    }
  }

  const headers = [
    'level','routeId','leg','path','dexType','inAmount_SOL','outAmount_SOL',
    'profitLamports','profitBps','sumFeeBps','sumImpactBps','sumTradeRatioPct',
    'grossEdgeBps','edgeMinusFeesBps','feeBps','impactBps','tradeRatioPct',
    'grossImpactPct','inSym','outSym','inAmount','outAmount','quoteSource'
  ];

  let csv = headers.join(',') + '\n';
  for (const row of csvRows) {
    const values = headers.map(h => {
      const v = row[h];
      if (v === null || v === undefined || v === '') return '';
      const s = String(v);
      if (/[,"\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    });
    csv += values.join(',') + '\n';
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, csv, 'utf8');
  console.log(`[tradeReportGenerator] CSV saved: ${outputPath} (${csvRows.length} rows)`);
  return outputPath;
}

function generateHtmlReportJson(routes, outputPath) {
  if (!Array.isArray(routes) || routes.length === 0) {
    console.warn('[tradeReportGenerator] No routes to export to HTML JSON');
    return null;
  }

  const reportRoutes = routes.map(route => {
    const aggregates = computeRouteAggregates(route);
    return buildHtmlReportRoute(route, aggregates);
  });

  const payload = { ROUTES: reportRoutes };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`[tradeReportGenerator] HTML report JSON saved: ${outputPath} (${reportRoutes.length} routes)`);
  return outputPath;
}

/* -------------------------------------------------------------------------- */
/*                          Embedded HTML Template                            */
/* -------------------------------------------------------------------------- */
/* Same Bloomberg-terminal layout, no external file required. The placeholder
 * line `const ROUTES = [];` is replaced at generation time. If a user provides
 * an external template at templates/tradeResults_report_template.html, that
 * one wins (the file-based path is preserved for customization).
 */

const EMBEDDED_TEMPLATE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Triangle Arb · Run Forensics</title>
<style>:root{--bg:#0a0d10;--panel:#0f1418;--line:#1c252c;--line2:#243038;--text:#d6dde3;--dim:#7c8a93;--faint:#4f5b62;--green:#5fd28a;--red:#ff6660;--amber:#f5c95e;--cyan:#58c6e0;--gross:#bb8fff;--gridline:#172026}*{box-sizing:border-box}html,body{margin:0;padding:0;background:var(--bg);color:var(--text);font:13px/1.5 "JetBrains Mono","SF Mono","Menlo",ui-monospace,monospace}header{padding:22px 28px 16px;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:6px;background:linear-gradient(180deg,#0d1216,#0a0d10)}h1{margin:0;font:600 14px/1.2 monospace;letter-spacing:.18em;text-transform:uppercase}h1 span{color:var(--cyan)}.sub{color:var(--dim);font-size:11px;letter-spacing:.12em;text-transform:uppercase}.kpis{padding:18px 28px;border-bottom:1px solid var(--line);display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1px;background:var(--line)}.kpi{background:var(--panel);padding:12px 14px}.kpi .v{font-size:18px;font-weight:600}.kpi .l{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.14em;margin-top:2px}.kpi.ok .v{color:var(--green)}.kpi.warn .v{color:var(--amber)}.kpi.bad .v{color:var(--red)}main{padding:18px 28px}table{width:100%;border-collapse:collapse;font-size:12px}thead th{position:sticky;top:0;z-index:2;background:#0d1418;color:var(--dim);font:600 10px/1.2 monospace;letter-spacing:.12em;text-transform:uppercase;text-align:right;padding:10px 8px;border-bottom:1px solid var(--line2);cursor:pointer;user-select:none;white-space:nowrap}thead th:first-child{text-align:left}thead th:hover{color:var(--text)}thead th.sorted{color:var(--cyan)}thead th.sorted::after{content:" ▾";font-size:9px}thead th.sorted.asc::after{content:" ▴"}tbody tr{border-bottom:1px solid var(--gridline)}tbody tr:hover{background:#101820}td{padding:8px 8px;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}td.l{text-align:left}td.dim{color:var(--dim)}td.id{color:var(--faint);font-size:11px}.bar{display:inline-block;height:6px;border-radius:1px;vertical-align:middle;margin-left:6px}.cell-bar{display:flex;justify-content:flex-end;align-items:center;gap:6px}.tag{display:inline-block;padding:2px 6px;font-size:10px;font-weight:600;letter-spacing:.06em;border-radius:2px;background:#16202a;color:var(--dim);border:1px solid var(--line2)}.tag.WHI,.tag.WHIRLPOOL{color:#ff9a4d;border-color:#3d2818}.tag.CLM,.tag.CLMM{color:#58c6e0;border-color:#163842}.tag.CPM,.tag.CPMM{color:#f5c95e;border-color:#3d3315}.tag.DLM,.tag.DLMM{color:#bb8fff;border-color:#2c1f3d}.profit-pos{color:var(--green);font-weight:600}.profit-neg{color:var(--red);font-weight:600}.profit-zero{color:var(--dim)}.gross-pos{color:var(--gross);font-weight:600}.expand-btn{background:none;border:1px solid var(--line2);color:var(--dim);cursor:pointer;font:11px monospace;padding:1px 6px;border-radius:2px}.expand-btn:hover{color:var(--cyan);border-color:var(--cyan)}tr.legs{display:none}tr.legs.open{display:table-row}tr.legs td{padding:0;background:#080b0e}.legs-wrap{padding:8px 30px 14px;border-bottom:1px solid var(--line)}.legs-wrap table{width:100%}.legs-wrap td,.legs-wrap th{padding:5px 8px;font-size:11px;border:none}.legs-wrap th{color:var(--faint);text-transform:uppercase;letter-spacing:.1em;font-size:9px;text-align:right;border-bottom:1px solid var(--line)}.legs-wrap th:first-child{text-align:left}.legs-wrap td.l{text-align:left}.legs-wrap .pool-addr{color:var(--faint);font-size:10px}.controls{display:flex;gap:10px;margin-bottom:14px;align-items:center;flex-wrap:wrap}.controls input{background:var(--panel);border:1px solid var(--line2);color:var(--text);padding:6px 10px;font:12px monospace;border-radius:2px;min-width:200px}.controls label{color:var(--dim);font-size:11px;letter-spacing:.08em;text-transform:uppercase}.legend{display:flex;gap:18px;margin-top:6px;font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.1em}.empty{padding:30px 20px;text-align:center;color:var(--dim);font-size:12px;background:var(--panel);border:1px solid var(--line);margin-top:18px}</style></head><body>
<header><h1>TRIANGLE ARB · <span>RUN FORENSICS</span></h1><div class="sub" id="subline">— routes simulated · click ▸ to expand legs · click headers to sort</div></header>
<section class="kpis" id="kpis"></section>
<main>
<div class="controls"><input id="filter" placeholder="filter routes (path / dex / id)…"><label>min gross bps</label><input id="minGross" type="number" placeholder="any" style="min-width:80px"></div>
<table id="routes"><thead><tr><th data-sort="routeId">Route</th><th data-sort="path">Path</th><th data-sort="dexCombo">DEX</th><th data-sort="profitBps" class="sorted">Net&nbsp;bps</th><th data-sort="feeBps">Fee&nbsp;bps</th><th data-sort="impactBps">Impact&nbsp;bps</th><th data-sort="tradeRatioPct">Size/TVL&nbsp;%</th><th data-sort="grossEdgeBps">Gross&nbsp;bps</th><th data-sort="edgeMinusFeesBps">Edge−Fee</th><th></th></tr></thead><tbody></tbody></table>
<div id="emptyState" class="empty" style="display:none">No routes returned by the engine for this run.</div>
</main>
<script>
const ROUTES = [];
const tbody=document.querySelector('#routes tbody');
const fmtBps=n=>(n>0?'+':'')+(Number.isInteger(Number(n))?n:Number(n).toFixed(2));
const cls=n=>n>0?'profit-pos':(n<0?'profit-neg':'profit-zero');
const fmtPct=n=>Number(n).toFixed(4);
let sortKey='profitBps',sortAsc=false,filterText='',minGross=null;
function maxAbs(a,k){return Math.max(1,...a.map(r=>Math.abs(Number(r[k])||0)))}
function renderKpis(){const k=document.getElementById('kpis');if(!ROUTES.length){k.innerHTML='';return}const p=ROUTES.filter(r=>r.profitBps>0).length;const bn=ROUTES.reduce((m,r)=>Math.max(m,r.profitBps),-Infinity);const mg=ROUTES.reduce((m,r)=>Math.max(m,r.grossEdgeBps),-Infinity);const mi=ROUTES.reduce((m,r)=>Math.max(m,r.impactBps),0);const mf=ROUTES.reduce((m,r)=>Math.min(m,r.feeBps),Infinity);k.innerHTML=\`<div class="kpi \${p>0?'ok':''}"><div class="v">\${ROUTES.length}</div><div class="l">Routes</div></div><div class="kpi \${p>0?'ok':'bad'}"><div class="v">\${p}</div><div class="l">Profitable</div></div><div class="kpi \${bn>0?'ok':'warn'}"><div class="v">\${fmtBps(bn)} bps</div><div class="l">Best Net</div></div><div class="kpi"><div class="v">\${fmtBps(mg)} bps</div><div class="l">Max Gross Edge</div></div><div class="kpi \${mi>100?'bad':''}"><div class="v">\${mi.toFixed(0)} bps</div><div class="l">Max Impact</div></div><div class="kpi"><div class="v">\${mf} bps</div><div class="l">Min Fee</div></div>\`;document.getElementById('subline').textContent=\`\${ROUTES.length} routes · \${p} profitable · click ▸ to expand legs · click headers to sort\`}
function render(){if(!ROUTES.length){document.getElementById('emptyState').style.display='block';document.querySelector('#routes').style.display='none';return}let rows=ROUTES.filter(r=>{if(filterText){const b=(r.routeId+r.path+r.dexCombo).toLowerCase();if(!b.includes(filterText.toLowerCase()))return false}if(minGross!==null&&r.grossEdgeBps<minGross)return false;return true});rows.sort((a,b)=>{const A=a[sortKey],B=b[sortKey];if(typeof A==='string')return sortAsc?A.localeCompare(B):B.localeCompare(A);return sortAsc?(A-B):(B-A)});const mxG=maxAbs(rows,'grossEdgeBps'),mxF=maxAbs(rows,'feeBps');tbody.innerHTML='';for(const r of rows){const tr=document.createElement('tr');const gW=Math.max(2,Math.abs(r.grossEdgeBps)/mxG*60),fW=Math.max(2,r.feeBps/mxF*40);tr.innerHTML=\`<td class="l id">\${r.routeId}</td><td class="l">\${r.path}</td><td class="l">\${r.dexCombo.split('\\u00b7').map(d=>'<span class="tag '+d+'">'+d+'</span>').join(' ')}</td><td class="\${cls(r.profitBps)}">\${fmtBps(r.profitBps)}</td><td><div class="cell-bar"><span>\${r.feeBps}</span><span class="bar" style="width:\${fW}px;background:var(--amber)"></span></div></td><td class="dim">\${fmtPct(r.impactBps)}</td><td class="dim">\${fmtPct(r.tradeRatioPct)}</td><td><div class="cell-bar"><span class="\${r.grossEdgeBps>0?'gross-pos':'profit-neg'}">\${fmtBps(r.grossEdgeBps)}</span><span class="bar" style="width:\${gW}px;background:var(--gross);opacity:\${r.grossEdgeBps>0?1:.3}"></span></div></td><td class="\${cls(r.edgeMinusFeesBps)}">\${fmtBps(r.edgeMinusFeesBps)}</td><td><button class="expand-btn">▸</button></td>\`;tbody.appendChild(tr);const tr2=document.createElement('tr');tr2.className='legs';tr2.innerHTML=\`<td colspan="10"><div class="legs-wrap"><table><thead><tr><th>Leg</th><th>DEX</th><th>From → To</th><th>In</th><th>Out</th><th>Fee bps</th><th>Impact bps</th><th>Size/TVL %</th><th>Gross Impact %</th><th>Quote</th><th>Pool</th></tr></thead><tbody>\${r.legs.map(l=>'<tr><td>'+l.legIndex+'</td><td><span class="tag '+l.dex.slice(0,3)+'">'+l.dex.slice(0,3)+'</span></td><td class="l">'+l.inSym+' → '+l.outSym+'</td><td>'+(Number(l.inAmount)/1e9).toFixed(6)+'</td><td>'+(Number(l.outAmount)/1e9).toFixed(6)+'</td><td>'+l.feeBps+'</td><td>'+Number(l.impactBps).toFixed(4)+'</td><td>'+Number(l.tradeRatioPct).toFixed(4)+'</td><td>'+Number(l.grossImpactPct).toFixed(4)+'</td><td class="dim">'+(l.quoteSource||'')+'</td><td class="l pool-addr">'+(l.pool||'').slice(0,8)+'…'+(l.pool||'').slice(-4)+'</td></tr>').join('')}</tbody></table></div></td>\`;tbody.appendChild(tr2);tr.querySelector('.expand-btn').addEventListener('click',e=>{e.stopPropagation();tr2.classList.toggle('open');e.target.textContent=tr2.classList.contains('open')?'▾':'▸'})}}
document.querySelectorAll('th[data-sort]').forEach(th=>{th.addEventListener('click',()=>{const k=th.dataset.sort;if(sortKey===k)sortAsc=!sortAsc;else{sortKey=k;sortAsc=false}document.querySelectorAll('th').forEach(x=>x.classList.remove('sorted','asc'));th.classList.add('sorted');if(sortAsc)th.classList.add('asc');render()})});
document.getElementById('filter').addEventListener('input',e=>{filterText=e.target.value;render()});
document.getElementById('minGross').addEventListener('input',e=>{minGross=e.target.value===''?null:Number(e.target.value);render()});
renderKpis();render();
</script></body></html>`;

function generateHtmlReport(routes, outputPath, templatePath = null) {
  // External template wins if provided and exists.
  let template = (templatePath && fs.existsSync(templatePath))
    ? fs.readFileSync(templatePath, 'utf8')
    : EMBEDDED_TEMPLATE;

  const reportRoutes = routes.map(route => {
    const aggregates = computeRouteAggregates(route);
    return buildHtmlReportRoute(route, aggregates);
  });

  const routesJson = JSON.stringify(reportRoutes, null, 2);
  template = template.replace(
    /const ROUTES\s*=\s*\[.*?\];/s,
    `const ROUTES = ${routesJson};`
  );

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, template, 'utf8');
  console.log(`[tradeReportGenerator] HTML report saved: ${outputPath}`);
  return outputPath;
}

/**
 * Main entry point — call at end of myEngine.runEngine() or in main()
 *
 * @param {Object} engineResult — result object from runEngine()
 * @param {string} baseOutputPath — path from --output flag (default: 04_runtimeResults.json)
 * @param {Object} options
 * @param {string} options.csvPath — explicit CSV destination
 * @param {string} options.htmlPath — explicit HTML destination
 * @param {string} options.htmlJsonPath — explicit HTML JSON destination
 * @param {string} options.jsonPath — alias for options.htmlJsonPath
 */
async function generateTradeReports(engineResult, baseOutputPath, options = {}) {
  const resolvedBase = path.resolve(baseOutputPath || DEFAULT_RUNTIME_OUTPUT);
  const baseDir = path.dirname(resolvedBase);

  const routeBuckets = [
    engineResult.executionEligibleTopRoutes,
    engineResult.topRoutes,
    engineResult.topGatedRoutes,
    engineResult.diagnosticTopRoutes,
    engineResult.submissionCandidates,
  ];
  const routes = routeBuckets.find((bucket) => Array.isArray(bucket) && bucket.length > 0) || [];

  if (routes.length === 0) {
    console.warn('[tradeReportGenerator] No routes found in engine result');
    return { csv: null, html: null, htmlJson: null };
  }

  const csvPath      = options.csvPath ? path.resolve(options.csvPath) : path.join(baseDir, DEFAULT_CSV_OUTPUT);
  const htmlJsonPath = (options.htmlJsonPath || options.jsonPath)
    ? path.resolve(options.htmlJsonPath || options.jsonPath)
    : path.join(baseDir, DEFAULT_JSON_OUTPUT);
  const htmlPath     = options.htmlPath ? path.resolve(options.htmlPath) : path.join(baseDir, DEFAULT_HTML_OUTPUT);
  const templatePath = path.join(__dirname, '..', 'templates', 'tradeResults_report_template.html');

  generateCsvFromRoutes(routes, csvPath);
  generateHtmlReportJson(routes, htmlJsonPath);
  generateHtmlReport(routes, htmlPath, fs.existsSync(templatePath) ? templatePath : null);

  return {
    csv: csvPath,
    html: htmlPath,
    htmlJson: htmlJsonPath,
  };
}

module.exports = {
  generateTradeReports,
  generateCsvFromRoutes,
  generateHtmlReportJson,
  generateHtmlReport,
  computeRouteAggregates,
  DEFAULT_RUNTIME_OUTPUT,
  DEFAULT_CSV_OUTPUT,
  DEFAULT_JSON_OUTPUT,
  DEFAULT_HTML_OUTPUT,
};
