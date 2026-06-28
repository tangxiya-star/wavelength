// Self-contained black & white admin dashboard, served at GET /admin.
// Vanilla JS: login, generate access codes, watch data land (near real-time),
// download CSVs. No build step, no external assets.

export const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Admin</title>
<style>
  :root { --bd:#000; --mut:#666; }
  * { box-sizing:border-box; }
  body { margin:0; background:#fff; color:#000; font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  a { color:#000; }
  header { display:flex; align-items:center; justify-content:space-between; padding:14px 20px; border-bottom:2px solid var(--bd); position:sticky; top:0; background:#fff; }
  h1 { font-size:15px; margin:0; letter-spacing:1px; text-transform:uppercase; }
  h2 { font-size:12px; letter-spacing:1px; text-transform:uppercase; color:var(--mut); margin:0 0 10px; }
  h3.sub { font-size:10px; letter-spacing:1px; text-transform:uppercase; color:var(--mut); margin:18px 0 8px; font-weight:700; }
  main { max-width:980px; margin:0 auto; padding:20px; }
  section { border:2px solid var(--bd); padding:16px; margin-bottom:18px; }
  label { display:block; font-size:11px; text-transform:uppercase; letter-spacing:1px; color:var(--mut); margin-bottom:4px; }
  input { font:inherit; padding:8px 10px; border:2px solid var(--bd); background:#fff; color:#000; width:100%; }
  button { font:inherit; padding:8px 14px; border:2px solid var(--bd); background:#000; color:#fff; cursor:pointer; text-transform:uppercase; letter-spacing:1px; font-size:12px; }
  button.ghost { background:#fff; color:#000; }
  button:hover { opacity:.8; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th,td { border:1px solid var(--bd); padding:6px 8px; text-align:left; vertical-align:top; }
  th { text-transform:uppercase; font-size:10px; letter-spacing:1px; }
  .row { display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end; }
  .row > div { flex:1; min-width:120px; }
  .grid { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; }
  .stat { border:2px solid var(--bd); padding:12px; text-align:center; }
  .stat .n { font-size:28px; font-weight:700; }
  .stat .l { font-size:10px; text-transform:uppercase; letter-spacing:1px; color:var(--mut); }
  .mono { font-family:inherit; }
  .codes { font-size:16px; letter-spacing:2px; }
  .muted { color:var(--mut); }
  .pill { border:1px solid var(--bd); padding:1px 6px; font-size:11px; }
  .bar { display:flex; gap:10px; align-items:center; }
  .hide { display:none; }
  .num { text-align:right; font-variant-numeric:tabular-nums; }
  .barcell { padding:4px 8px; }
  .barwrap { display:flex; align-items:center; gap:8px; }
  .barfill { height:12px; background:#000; min-width:1px; }
  .barlbl { font-variant-numeric:tabular-nums; white-space:nowrap; }
</style>
</head>
<body>

<div id="app">
  <header>
    <h1>Admin</h1>
    <div class="bar">
      <label class="mono" style="margin:0;display:flex;align-items:center;gap:6px;text-transform:none">
        <input type="checkbox" id="auto" checked style="width:auto" onchange="toggleAuto()" /> auto-refresh
      </label>
      <button class="ghost" onclick="refreshAll()">Refresh</button>
    </div>
  </header>
  <main>
    <section>
      <h2>Generate access code</h2>
      <div class="row">
        <div><label>Label</label><input id="cLabel" placeholder="Pilot batch 1" /></div>
        <div><label>Minutes</label><input id="cMin" type="number" value="30" /></div>
        <div><label>How many</label><input id="cCount" type="number" value="1" /></div>
        <div style="flex:0"><button onclick="genCode()">Generate</button></div>
      </div>
      <div id="genOut" class="codes" style="margin-top:12px"></div>
    </section>

    <section>
      <h2>Live summary</h2>
      <div class="grid" id="stats"></div>
      <div id="byType" class="muted" style="margin-top:12px;font-size:12px"></div>
    </section>

    <section>
      <h2>Retention metrics</h2>
      <div class="grid" id="mStats"></div>
      <h3 class="sub">Engagement by content type</h3>
      <div id="byContent"></div>
      <h3 class="sub">Retention curve — engagement by feed position</h3>
      <div id="curve"></div>
    </section>

    <section>
      <h2>Access codes</h2>
      <div id="codes"></div>
    </section>

    <section>
      <h2>Recent sessions</h2>
      <div id="sessions"></div>
    </section>

    <section>
      <h2>Download data</h2>
      <h3 class="sub">Raw</h3>
      <div class="bar">
        <button onclick="download('events')">events.csv</button>
        <button onclick="download('responses')">responses.csv</button>
      </div>
      <h3 class="sub">Derived metrics</h3>
      <div class="bar" style="flex-wrap:wrap">
        <button onclick="download('metrics_by_content')">metrics_by_content.csv</button>
        <button onclick="download('metrics_by_video')">metrics_by_video.csv</button>
        <button onclick="download('retention_curve')">retention_curve.csv</button>
        <button onclick="download('per_video_participant')">per_video_participant.csv</button>
      </div>
    </section>
  </main>
</div>

<script>
var timer = null;

function esc(s){ s = (s==null?'':String(s)); return s.replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];}); }

async function api(path, opts){
  opts = opts || {};
  var headers = Object.assign({ 'Content-Type':'application/json' }, opts.headers||{});
  return fetch(path, Object.assign({}, opts, { headers: headers }));
}

function toggleAuto(){
  if(timer){ clearInterval(timer); timer=null; }
  if(document.getElementById('auto').checked){ timer = setInterval(refreshLive, 4000); }
}
function refreshAll(){ refreshLive(); loadCodes(); }
function refreshLive(){ loadSummary(); loadMetrics(); loadSessions(); }

async function genCode(){
  var label = document.getElementById('cLabel').value || null;
  var sessionMinutes = parseInt(document.getElementById('cMin').value,10) || 30;
  var count = parseInt(document.getElementById('cCount').value,10) || 1;
  var r = await api('/api/admin/codes', { method:'POST', body:JSON.stringify({label:label, sessionMinutes:sessionMinutes, count:count}) });
  var d = await r.json();
  document.getElementById('genOut').textContent = (d.codes||[]).join('   ');
  loadCodes();
}

async function loadSummary(){
  var d = await (await api('/api/admin/summary')).json();
  var s = document.getElementById('stats');
  function card(n,l){ return '<div class="stat"><div class="n">'+n+'</div><div class="l">'+l+'</div></div>'; }
  s.innerHTML = card(d.participants,'participants') + card(d.sessions,'sessions') + card(d.completed,'completed') + card(d.events,'events');
  var bt = (d.byType||[]).map(function(t){ return '<span class="pill">'+esc(t.event_type)+': '+t.n+'</span>'; }).join(' ');
  document.getElementById('byType').innerHTML = bt;
}

function fmt(v){ return v==null ? '—' : v; }

async function loadMetrics(){
  var d = await (await api('/api/admin/metrics')).json();
  var o = d.overall || {};
  function card(n,l){ return '<div class="stat"><div class="n">'+fmt(n)+'</div><div class="l">'+l+'</div></div>'; }
  document.getElementById('mStats').innerHTML =
    card(o.views,'views') + card((o.avg_dwell_s!=null?o.avg_dwell_s+'s':'—'),'avg dwell') +
    card((o.avg_watch_s!=null?o.avg_watch_s+'s':'—'),'avg watch') +
    card((o.completion_pct!=null?o.completion_pct+'%':'—'),'completion');

  // Headline: engagement compared across content types.
  var ct = d.byContentType || [];
  if (ct.length){
    var h = '<table><tr><th>Content type</th><th class="num">Views</th><th class="num">Avg dwell</th><th class="num">Avg watch</th><th class="num">% watched</th><th class="num">Completion</th><th class="num">Loops</th><th class="num">Like %</th><th class="num">Save %</th></tr>';
    ct.forEach(function(r){
      h += '<tr><td>'+esc(r.content_type)+'</td>'+
           '<td class="num">'+fmt(r.views)+'</td>'+
           '<td class="num">'+fmt(r.avg_dwell_s)+'s</td>'+
           '<td class="num">'+fmt(r.avg_watch_s)+'s</td>'+
           '<td class="num">'+(r.avg_pct_watched!=null?Math.round(r.avg_pct_watched*100)+'%':'—')+'</td>'+
           '<td class="num">'+fmt(r.completion_pct)+'%</td>'+
           '<td class="num">'+fmt(r.avg_loops)+'</td>'+
           '<td class="num">'+fmt(r.like_rate_pct)+'%</td>'+
           '<td class="num">'+fmt(r.save_rate_pct)+'%</td></tr>';
    });
    h += '</table>';
    document.getElementById('byContent').innerHTML = h;
  } else {
    document.getElementById('byContent').innerHTML = '<span class="muted">No engagement data yet.</span>';
  }

  // Retention curve: avg dwell by feed position, drawn as horizontal bars.
  var cv = d.retentionCurve || [];
  if (cv.length){
    var max = cv.reduce(function(m,r){ return Math.max(m, r.avg_dwell_s||0); }, 0) || 1;
    var h2 = '<table><tr><th>Pos</th><th class="num">Views</th><th>Avg dwell</th><th class="num">% watched</th></tr>';
    cv.forEach(function(r){
      var w = Math.round(120 * (r.avg_dwell_s||0) / max);
      h2 += '<tr><td class="num">'+fmt(r.feed_position)+'</td>'+
            '<td class="num">'+fmt(r.views)+'</td>'+
            '<td class="barcell"><div class="barwrap"><div class="barfill" style="width:'+w+'px"></div>'+
            '<span class="barlbl">'+fmt(r.avg_dwell_s)+'s</span></div></td>'+
            '<td class="num">'+(r.avg_pct_watched!=null?Math.round(r.avg_pct_watched*100)+'%':'—')+'</td></tr>';
    });
    h2 += '</table>';
    document.getElementById('curve').innerHTML = h2;
  } else {
    document.getElementById('curve').innerHTML = '<span class="muted">No engagement data yet.</span>';
  }
}

async function loadCodes(){
  var rows = await (await api('/api/admin/codes')).json();
  var html = '<table><tr><th>Code</th><th>Label</th><th>Min</th><th>Uses</th><th>Active</th><th>Created</th></tr>';
  rows.forEach(function(c){
    html += '<tr><td class="mono"><b>'+esc(c.code)+'</b></td><td>'+esc(c.label)+'</td><td>'+esc(c.session_minutes)+'</td><td>'+esc(c.uses_count)+(c.max_uses!=null?(' / '+c.max_uses):'')+'</td><td>'+(c.active?'yes':'no')+'</td><td class="muted">'+esc(c.created_at)+'</td></tr>';
  });
  html += '</table>';
  document.getElementById('codes').innerHTML = rows.length ? html : '<span class="muted">No codes yet.</span>';
}

async function loadSessions(){
  var rows = await (await api('/api/admin/sessions')).json();
  var html = '<table><tr><th>Session</th><th>Code</th><th>Started</th><th>Ended</th><th>Reason</th><th>Events</th><th>Demographics</th><th>Device</th></tr>';
  rows.forEach(function(s){
    var demo = [s.age_band, s.sex_at_birth, s.gender_identity, s.daily_shortform_use].filter(Boolean).join(' · ');
    var dev = '';
    try { var dj = s.device ? JSON.parse(s.device) : null; if(dj) dev = [dj.modelName||dj.deviceName, dj.osName, dj.osVersion].filter(Boolean).join(' '); } catch(e){}
    html += '<tr><td class="mono">'+esc((s.id||'').slice(0,8))+'</td><td class="mono">'+esc(s.access_code)+'</td><td class="muted">'+esc(s.started_at)+'</td><td class="muted">'+esc(s.ended_at||'—')+'</td><td>'+esc(s.end_reason||'')+'</td><td>'+esc(s.event_count)+'</td><td>'+esc(demo)+'</td><td class="muted">'+esc(dev)+'</td></tr>';
  });
  html += '</table>';
  document.getElementById('sessions').innerHTML = rows.length ? html : '<span class="muted">No sessions yet.</span>';
}

async function download(table){
  var r = await api('/api/admin/export?table='+table);
  var blob = await r.blob();
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a'); a.href=url; a.download=table+'.csv'; document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

refreshAll();
toggleAuto();
</script>
</body>
</html>`;
