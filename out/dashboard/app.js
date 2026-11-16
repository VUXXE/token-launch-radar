(function(){
  const D = window.RADAR;
  if(!D) return;
  const $ = (s,el=document)=>el.querySelector(s);
  const esc = s=>String(s).replace(/[&<>"']/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const fmtUsd = n => '$' + Number(n).toLocaleString('en-US');
  const fmtCompact = n => {
    const a=Math.abs(n);
    if(a>=1e9) return '$'+(n/1e9).toFixed(2)+'B';
    if(a>=1e6) return '$'+(n/1e6).toFixed(1)+'M';
    if(a>=1e3) return '$'+(n/1e3).toFixed(1)+'K';
    return '$'+Math.round(n);
  };
  const fmtPct = v => v==null ? '—' : (v>0?'+':'')+Number(v).toFixed(2)+'%';
  const fmtAge = d => {
    if(d>=365) return (d/365).toFixed(1)+'y';
    if(d>=30) return Math.round(d/30)+'mo';
    return d+'d';
  };
  const state = { q:'', cat:'', chain:'', preOnly:true, sort:'rank', dir:1, liveView:false };

  function readUrl(){
    const sp = new URLSearchParams(location.search);
    state.q = sp.get('q') || '';
    state.cat = sp.get('cat') || sp.get('category') || '';
    state.chain = sp.get('chain') || '';
    if(sp.get('pre')==='0' || sp.get('pretoken')==='0') state.preOnly=false;
    if(sp.get('view')==='live') { state.liveView=true; state.preOnly=false; }
  }
  function writeUrl(replace=true){
    const sp = new URLSearchParams();
    if(state.q) sp.set('q', state.q);
    if(state.cat) sp.set('cat', state.cat);
    if(state.chain) sp.set('chain', state.chain);
    if(!state.preOnly && !state.liveView) sp.set('pre','0');
    if(state.liveView) sp.set('view','live');
    const qs = sp.toString();
    const url = location.pathname + (qs?('?'+qs):'') + location.hash;
    replace ? history.replaceState(null,'',url) : history.pushState(null,'',url);
  }
  function route(){
    const h = location.hash || '';
    const m = h.match(/^#\/p\/([^?#]+)/);
    if(m){
      const slug = decodeURIComponent(m[1]);
      showDetail(slug);
    } else {
      showBoard();
    }
  }

  function meta(){
    $('#meta').innerHTML = `<span class="pill">Snapshot ${esc(D.as_of)}</span><span class="pill">Model ${esc(D.model_version)}</span><span class="pill">${D.rows.length} ranked</span>`;
  }

  function uniqueChains(rows){
    const s=new Set();
    rows.forEach(r=> (r.chains||[]).forEach(c=>s.add(c)));
    return Array.from(s).sort();
  }
  const allCats = Array.from(new Set(D.rows.map(r=>r.category).filter(Boolean))).sort();
  const allChains = uniqueChains(D.rows);

  function filteredRows(){
    let rows = D.rows.slice();
    if(state.cat) rows = rows.filter(r=> (r.category||'')===state.cat);
    if(state.chain) rows = rows.filter(r=> (r.chains||[]).includes(state.chain));
    if(state.q){
      const q=state.q.toLowerCase();
      rows = rows.filter(r => (r.name+' '+r.slug+' '+(r.category||'')+' '+(r.chains||[]).join(' ')).toLowerCase().includes(q));
    }
    return rows;
  }
  function sortRows(rows){
    const k=state.sort, d=state.dir;
    const val = r => {
      if(k==='rank') return r.rank;
      if(k==='implied') return r.implied_value_usd;
      if(k==='tvl') return r.tvl_usd;
      if(k==='change') return r.change_7d==null ? -1e15 : r.change_7d;
      if(k==='age') return r.age_days;
      return r.rank;
    };
    return rows.slice().sort((a,b)=>{
      const va=val(a), vb=val(b);
      if(va===vb) return a.rank-b.rank;
      return va<vb ? -d : d;
    });
  }

  function boardControls(){
    const catOpts = ['<option value="">All categories</option>'].concat(allCats.map(c=>`<option value="${esc(c)}"${c===state.cat?' selected':''}>${esc(c)}</option>`)).join('');
    const chainOpts = ['<option value="">All chains</option>'].concat(allChains.map(c=>`<option value="${esc(c)}"${c===state.chain?' selected':''}>${esc(c)}</option>`)).join('');
    return `<div class="controls">
      <label>Search<input id="q" type="search" placeholder="Name, slug, chain..." value="${esc(state.q)}"></label>
      <label>Category<select id="cat">${catOpts}</select></label>
      <label>Chain<select id="chain">${chainOpts}</select></label>
      <label>View<select id="viewsel"><option value="board"${!state.liveView?' selected':''}>Ranked board</option><option value="live"${state.liveView?' selected':''}>Live comparables</option></select></label>
      <label class="toggle"><input id="pre" type="checkbox"${state.preOnly?' checked':''}${state.liveView?' disabled':''}>Pre-token only</label>
    </div>`;
  }
  function sortTh(key,label){
    const active = state.sort===key;
    const arrow = active ? (state.dir===1?' ▲':' ▼') : '';
    return `<th class="sort" data-k="${key}">${label}${arrow}</th>`;
  }
  function boardTable(){
    const rows = sortRows(filteredRows());
    if(state.liveView) return liveTable();
    if(rows.length===0) return `<div class="empty">No protocols match the current filters.</div>`;
    const body = rows.map(r=>{
      const chg = r.change_7d==null ? '<span class="muted">—</span>' : `<span class="${r.change_7d>=0?'pos':'neg'}">${fmtPct(r.change_7d)}</span>`;
      return `<tr data-slug="${esc(r.slug)}">
        <td class="num rank">#${r.rank}</td>
        <td><div>${esc(r.name)}</div><div class="small muted">${esc(r.slug)} · ${esc(r.category||'Uncategorized')}</div></td>
        <td class="num">${fmtUsd(r.implied_value_usd)}</td>
        <td class="num">${fmtCompact(r.tvl_usd)}</td>
        <td class="num">${chg}</td>
        <td class="num">${fmtAge(r.age_days)}</td>
      </tr>`;
    }).join('');
    return `<div class="table-wrap"><table><thead><tr>
      ${sortTh('rank','Rank')}${sortTh('rank','Protocol')}${sortTh('implied','Implied value')}${sortTh('tvl','TVL')}${sortTh('change','7d change')}${sortTh('age','Age')}
    </tr></thead><tbody>${body}</tbody></table></div>`;
  }
  function liveTable(){
    let rows = D.live.slice();
    if(state.cat) rows = rows.filter(r=> (r.category||'')===state.cat);
    if(state.chain) rows = rows.filter(r=> (r.chains||[]).includes(state.chain));
    if(state.q){ const q=state.q.toLowerCase(); rows = rows.filter(r => (r.name+' '+r.slug+' '+(r.category||'')).toLowerCase().includes(q)); }
    if(rows.length===0) return `<div class="empty">No live comparables match the current filters.</div>`;
    const body = rows.map(r=>{
      const chg = r.change_7d==null ? '<span class="muted">—</span>' : `<span class="${r.change_7d>=0?'pos':'neg'}">${fmtPct(r.change_7d)}</span>`;
      return `<tr class="live-row"><td><div>${esc(r.name)}</div><div class="small muted">${esc(r.slug)} · ${esc(r.symbol||'')}</div></td>
        <td>${esc(r.category||'Uncategorized')}</td><td class="num">${fmtCompact(r.tvl_usd)}</td><td class="num">${r.mcap_usd?fmtCompact(r.mcap_usd):'—'}</td>
        <td class="num">${r.mcap_tvl!=null?Number(r.mcap_tvl).toFixed(2)+'x':'—'}</td><td class="num">${chg}</td></tr>`;
    }).join('');
    return `<div class="table-wrap"><table><thead><tr><th>Protocol</th><th>Category</th><th>TVL</th><th>Mcap</th><th>Mcap/TVL</th><th>7d change</th></tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function methodology(){
    return `<div class="method"><h3>Methodology</h3>
      <p><strong>What is ranked:</strong> Pre-token protocols only (gecko_id and symbol both null) from the sealed snapshot. Token-bearing protocols are excluded from the board and shown separately as live comparables.</p>
      <p><strong>Implied value (${esc(D.model_version)}):</strong> implied = round(TVL × category multiple × momentum × maturity), using snapshot figures only. The category multiple is the median mcap/TVL of token-bearing peers in the same category (≥3 peers, else the global median), clamped to [0.05, 2.00]. Momentum maps 7d change (clamped −60%..+120%, null treated as 0%) to a 0.70–1.60× factor. Maturity rises with days tracked without a token (0.70–1.30× over 0–5y; null listed_at defaults to 365 days) because long-running pre-token protocols have more to launch.</p>
      <p><strong>Watchlist:</strong> ${D.watchlist.length} protocol slugs at or above the $${Math.round(D.floor_usd/1e6)}M floor with no token on record, as defined by the snapshot. Every watchlist slug is present on the board.</p>
      <p><strong>Confidence:</strong> This is a comparative signal, not a price or launch promise. Confidence is higher when a category has many live peers (peer count shown in breakdown) and when TVL/change/age are present; treat small samples and volatile 7d moves with caution.</p>
    </div>`;
  }

  function showBoard(){
    $('#view-detail').classList.add('hidden');
    const vb=$('#view-board'); vb.classList.remove('hidden');
    vb.innerHTML = `<div class="panel">${boardControls()}${boardTable()}${!state.liveView?methodology():''}</div>`;
    bindBoard();
  }

  function bindBoard(){
    const q=$('#q'), cat=$('#cat'), chain=$('#chain'), pre=$('#pre'), viewsel=$('#viewsel');
    if(q){ q.addEventListener('input',e=>{ state.q=e.target.value; writeUrl(); updateBoard(); }); }
    if(cat){ cat.addEventListener('change',e=>{ state.cat=e.target.value; writeUrl(); updateBoard(); }); }
    if(chain){ chain.addEventListener('change',e=>{ state.chain=e.target.value; writeUrl(); updateBoard(); }); }
    if(pre){ pre.addEventListener('change',e=>{ state.preOnly=e.target.checked; writeUrl(); updateBoard(); }); }
    if(viewsel){ viewsel.addEventListener('change',e=>{ state.liveView=e.target.value==='live'; if(state.liveView) state.preOnly=false; else state.preOnly=true; writeUrl(); showBoard(); }); }
    document.querySelectorAll('th.sort').forEach(th=>{
      th.addEventListener('click',()=>{
        const k=th.dataset.k; if(!k) return;
        if(k==='rank' && th.textContent.includes('Protocol')) return; // protocol label shares rank slot
        if(state.sort===k) state.dir *= -1; else { state.sort=k; state.dir=(k==='rank'?1:-1); }
        updateBoard();
      });
    });
    document.querySelectorAll('tr[data-slug]').forEach(tr=>{
      tr.addEventListener('click',()=>{
        const slug=tr.dataset.slug; location.hash = '#/p/'+encodeURIComponent(slug);
      });
    });
  }
  function updateBoard(){
    const panel = $('#view-board .panel');
    if(!panel){ showBoard(); return; }
    // replace controls+table+method to keep state consistent
    panel.innerHTML = `${boardControls()}${boardTable()}${!state.liveView?methodology():''}`;
    bindBoard();
  }

  function parseStep(s){
    const t=String(s);
    const c=t.match(/Cost:\s*([^.]*(?:\.[^T][^.]*)*)\.\s*Time:\s*(.*)$/i) || t.match(/Cost:\s*(.*?)\s*Time:\s*(.*)$/i);
    let action=t, cost='', time='';
    if(c){ cost=c[1].trim().replace(/\.$/,''); time=c[2].trim().replace(/\.$/,''); action=t.replace(/\s*Cost:\s*.*$/i,'').trim(); }
    else {
      const c2=t.match(/Cost:\s*(.*)$/i); if(c2){ cost=c2[1].trim(); action=t.replace(/\s*Cost:\s*.*$/i,'').trim(); }
    }
    return {action, cost, time};
  }

  function waterfallSvg(r){
    const base = r.tvl_usd * r.category_multiple;
    const afterMom = base * r.momentum_multiplier;
    const afterMat = afterMom * r.maturity_multiplier;
    const vals = [r.tvl_usd, base, afterMom, afterMat];
    const max = Math.max(...vals,1);
    const W=520,H=140,p=28,bw=70,gap=40;
    const x=i=>p + i*(bw+gap);
    const bh=v=>Math.max(2, (v/max)*(H-p-20));
    const labels=['TVL','× Multiple','× Momentum','× Maturity'];
    const nums=[fmtCompact(r.tvl_usd), fmtCompact(base), fmtCompact(afterMom), fmtUsd(r.implied_value_usd)];
    let s=`<svg class="water" viewBox="0 0 ${W} ${H}" role="img" aria-label="Implied value breakdown">`;
    for(let i=0;i<4;i++){
      const h=bh(vals[i]), y=H-18-h, xx=x(i);
      const col=i===3?'#4fd1a5':'#5aa9ff';
      s+=`<rect x="${xx}" y="${y}" width="${bw}" height="${h}" rx="4" fill="${col}" opacity="${0.5+i*0.15}"></rect>`;
      s+=`<text x="${xx+bw/2}" y="${y-5}" text-anchor="middle" font-size="10" fill="#cfe3f7">${esc(nums[i])}</text>`;
      s+=`<text x="${xx+bw/2}" y="${H-4}" text-anchor="middle" font-size="10" fill="#93a4b8">${labels[i]}</text>`;
      if(i<3){ const x2=x(i+1); s+=`<line x1="${xx+bw}" y1="${y}" x2="${x2}" y2="${H-18-bh(vals[i+1])}" stroke="#35506d" stroke-dasharray="3 3"/>`; }
    }
    s+='</svg>';
    return s;
  }

  function comparablesFor(r){
    const peers = D.live.filter(p => (p.category||'') === (r.category||'') && p.mcap_tvl!=null);
    peers.sort((a,b)=>(b.mcap_tvl||0)-(a.mcap_tvl||0));
    return peers.slice(0,12);
  }

  function showDetail(slug){
    const r = D.rows.find(x=>x.slug===slug);
    $('#view-board').classList.add('hidden');
    const vd=$('#view-detail'); vd.classList.remove('hidden');
    if(!r){ vd.innerHTML=`<div class="panel card"><a class="back" href="#">← Back to board</a><p>Protocol not found.</p></div>`; return; }
    const peers = comparablesFor(r);
    const maxM = peers.length ? Math.max(...peers.map(p=>p.mcap_tvl||0), r.category_multiple) : r.category_multiple;
    const peerBars = peers.map(p=>{
      const w = maxM? Math.max(2,(p.mcap_tvl/maxM)*100):0;
      return `<div class="bar-row"><div title="${esc(p.name)}">${esc(p.name.length>18?p.name.slice(0,17)+'…':p.name)}</div><div class="bar"><i style="width:${w}%"></i></div><div class="num">${Number(p.mcap_tvl).toFixed(2)}x</div></div>`;
    }).join('') || '<div class="small muted">No live token-bearing peers in this category.</div>';
    const steps = (r.farm_steps||[]).map((s,i)=>{
      const p=parseStep(s);
      return `<li class="step"><div class="step-n">${i+1}</div><div><div>${esc(p.action||s)}</div><div class="chips">${p.cost?`<span class="chip cost">Cost: ${esc(p.cost)}</span>`:''}${p.time?`<span class="chip time">Time: ${esc(p.time)}</span>`:''}</div></div></li>`;
    }).join('');
    const chg = r.change_7d==null ? '—' : fmtPct(r.change_7d);
    const chgCls = r.change_7d==null ? 'muted' : (r.change_7d>=0?'pos':'neg');
    vd.innerHTML = `<a class="back" href="${location.pathname+location.search}">← Back to board</a>
      <div class="grid">
        <div class="panel card" style="grid-column:span 7">
          <h2>#${r.rank} ${esc(r.name)} <span class="tag">${esc(r.category||'Uncategorized')}</span></h2>
          <div class="small muted">${esc(r.slug)} · ${esc((r.chains||[]).join(', ')||'No chain listed')}</div>
          <div class="kv">
            <div class="item"><div class="k">Implied value</div><div class="v num">${fmtUsd(r.implied_value_usd)}</div></div>
            <div class="item"><div class="k">TVL</div><div class="v num">${fmtCompact(r.tvl_usd)}</div></div>
            <div class="item"><div class="k">7d change</div><div class="v num ${chgCls}">${chg}</div></div>
            <div class="item"><div class="k">Age (no token)</div><div class="v num">${fmtAge(r.age_days)} (${r.age_days}d)</div></div>
            <div class="item"><div class="k">Listed at</div><div class="v">${esc(r.listed_at||'unknown')}</div></div>
            <div class="item"><div class="k">Token status</div><div class="v">Pre-token</div></div>
          </div>
          <h3 style="margin-top:14px">Implied value breakdown (${esc(r.model_version)})</h3>
          ${waterfallSvg(r)}
          <div class="kv" style="margin-top:10px">
            <div class="item"><div class="k">Category multiple</div><div class="v num">${Number(r.category_multiple).toFixed(4)}x</div><div class="small muted">${esc(r.multiple_source)} median · ${r.peer_count} peers</div></div>
            <div class="item"><div class="k">Momentum factor</div><div class="v num">${Number(r.momentum_multiplier).toFixed(4)}x</div><div class="small muted">from 7d change ${r.change_7d==null?'(null→0%)':fmtPct(r.change_7d)}</div></div>
            <div class="item"><div class="k">Maturity factor</div><div class="v num">${Number(r.maturity_multiplier).toFixed(4)}x</div><div class="small muted">${r.age_days} days tracked</div></div>
          </div>
        </div>
        <div class="panel card" style="grid-column:span 5">
          <h3>Category comparables (live mcap/TVL)</h3>
          <p class="small muted">Token-bearing peers in "${esc(r.category||'Uncategorized')}" used as market context. This protocol's multiple: ${Number(r.category_multiple).toFixed(3)}x.</p>
          <div class="bars">${peerBars}</div>
        </div>
        <div class="panel card" style="grid-column:span 12">
          <h3>Farm plan</h3>
          <p class="small muted">Concrete steps derived from ${esc(r.name)}'s category, chains, TVL, and age. Costs/times are estimates; verify onchain before acting.</p>
          <ol class="steps">${steps}</ol>
        </div>
      </div>`;
  }

  function init(){
    meta();
    readUrl();
    window.addEventListener('hashchange', route);
    window.addEventListener('popstate', ()=>{ readUrl(); route(); });
    route();
  }
  init();
})();
