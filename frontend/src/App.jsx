import { useState, useMemo, useEffect, useCallback } from "react";
import { getTokens, getAlerts, getStats } from "./api.js";

// ─── UTILS ───
function getScoreColor(s){return s>=75?"#00e676":s>=50?"#ffab00":s>=25?"#ff6d00":"#ff1744";}
function getPotColor(p){return p>=70?"#00e5ff":p>=50?"#7c4dff":p>=30?"#ffab00":"#444";}
function getScoreLabel(s){return s>=75?"SAFE":s>=50?"CAUTION":s>=25?"RISKY":"DANGER";}
function getPotLabel(p){return p>=70?"HIGH x2":p>=50?"MODERATE":p>=30?"LOW":"MINIMAL";}
function fmt(n){if(!n)return"0";return n>=1e6?(n/1e6).toFixed(2)+"M":n>=1e3?(n/1e3).toFixed(1)+"K":n.toString();}
function fmtP(p){if(!p)return"$0";return p<.0001?p.toExponential(2):p<1?p.toFixed(6):p.toFixed(4);}

// ─── MINI COMPONENTS ───
function MiniChart({data,width=120,height=28,staircase}){
  if(!data||data.length<2)return <div style={{width,height,background:"rgba(255,255,255,0.02)",borderRadius:3}}/>;
  const filtered=data.filter(v=>v>0);if(filtered.length<2)return null;
  const mn=Math.min(...filtered),mx=Math.max(...filtered),r=mx-mn||1;
  const pts=filtered.map((v,i)=>`${(i/(filtered.length-1))*width},${height-((v-mn)/r)*(height-4)-2}`).join(" ");
  const col=staircase?"#ff1744":"#00e676";
  return(<svg width={width} height={height} style={{display:"block"}}><defs><linearGradient id={`mc${staircase?1:0}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={col} stopOpacity="0.12"/><stop offset="100%" stopColor={col} stopOpacity="0"/></linearGradient></defs><polygon points={`0,${height} ${pts} ${width},${height}`} fill={`url(#mc${staircase?1:0})`}/><polyline points={pts} fill="none" stroke={col} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>);
}

function ScoreBar({score,color}){const c=color||getScoreColor(score);return(<div style={{display:"flex",alignItems:"center",gap:5}}><div style={{width:44,height:4,borderRadius:2,background:"rgba(255,255,255,0.05)",overflow:"hidden"}}><div style={{width:`${Math.min(score,100)}%`,height:"100%",borderRadius:2,background:c}}/></div><span style={{color:c,fontSize:11,fontWeight:800,fontFamily:"var(--f)",minWidth:22}}>{score}</span></div>);}

function Badge({ok,label}){return(<span style={{display:"inline-block",padding:"2px 7px",borderRadius:3,fontSize:9,fontWeight:700,letterSpacing:"0.4px",background:ok?"rgba(0,230,118,0.1)":"rgba(255,23,68,0.1)",color:ok?"#00e676":"#ff1744",border:`1px solid ${ok?"rgba(0,230,118,0.2)":"rgba(255,23,68,0.2)"}`}}>{ok?"✓":"✗"} {label}</span>);}

// ─── TOKEN DETAIL MODAL ───
function TokenDetail({token,onClose}){
  const br=token.buys/(Math.max(token.buys+token.sells,1))*100;
  const checks=token.safety_checks||{};
  return(
    <div style={{position:"fixed",inset:0,zIndex:1000,background:"rgba(0,0,0,0.88)",backdropFilter:"blur(10px)",display:"flex",alignItems:"center",justifyContent:"center",padding:12}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#080a0f",border:"1px solid rgba(255,255,255,0.05)",borderRadius:8,width:"100%",maxWidth:560,padding:22,maxHeight:"92vh",overflowY:"auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:18}}>
          <div>
            <div style={{fontSize:9,color:"#333",fontFamily:"var(--f)",marginBottom:3,wordBreak:"break-all"}}>{token.address}</div>
            <div style={{fontSize:18,fontWeight:800,color:"#e8eaed",fontFamily:"var(--f)"}}>{token.name} <span style={{color:"#333"}}>/ {token.symbol}</span></div>
          </div>
          <div style={{display:"flex",gap:14}}>
            <div style={{textAlign:"center"}}><div style={{fontSize:8,color:"#444",letterSpacing:"1px",marginBottom:2}}>SAFETY</div><div style={{fontSize:26,fontWeight:900,color:getScoreColor(token.safety),fontFamily:"var(--f)",lineHeight:1}}>{token.safety}</div><div style={{fontSize:8,color:getScoreColor(token.safety),letterSpacing:"1px",fontWeight:700}}>{getScoreLabel(token.safety)}</div></div>
            <div style={{textAlign:"center"}}><div style={{fontSize:8,color:"#444",letterSpacing:"1px",marginBottom:2}}>POTENTIAL</div><div style={{fontSize:26,fontWeight:900,color:getPotColor(token.potential),fontFamily:"var(--f)",lineHeight:1}}>{token.potential}</div><div style={{fontSize:8,color:getPotColor(token.potential),letterSpacing:"1px",fontWeight:700}}>{getPotLabel(token.potential)}</div></div>
          </div>
        </div>

        {/* External Links */}
        <div style={{display:"flex",gap:6,marginBottom:14,flexWrap:"wrap"}}>
          {[
            {label:"DEX Screener",url:token.url||`https://dexscreener.com/solana/${token.pair_address}`},
            {label:"Birdeye",url:`https://birdeye.so/token/${token.address}?chain=solana`},
            {label:"Solscan",url:`https://solscan.io/token/${token.address}`},
            {label:"rugcheck",url:`https://rugcheck.xyz/tokens/${token.address}`},
          ].map((lk,i)=>(
            <a key={i} href={lk.url} target="_blank" rel="noopener noreferrer" style={{padding:"3px 10px",borderRadius:3,fontSize:9,fontWeight:600,letterSpacing:"0.5px",background:"rgba(255,255,255,0.03)",color:"#666",border:"1px solid rgba(255,255,255,0.06)",textDecoration:"none",fontFamily:"var(--f)"}}>{lk.label} ↗</a>
          ))}
        </div>

        {/* Chart */}
        <div style={{background:"rgba(255,255,255,0.015)",border:"1px solid rgba(255,255,255,0.04)",borderRadius:5,padding:14,marginBottom:14}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <span style={{fontSize:8,color:"#444",letterSpacing:"1.5px",fontWeight:700}}>PRICE ACTION</span>
            {token.staircase_detected?(
              <span style={{padding:"2px 8px",borderRadius:3,fontSize:9,fontWeight:800,background:"rgba(255,23,68,0.1)",color:"#ff1744",border:"1px solid rgba(255,23,68,0.25)"}}>⚠ STAIRCASE {token.staircase_confidence}%</span>
            ):(
              <span style={{padding:"2px 8px",borderRadius:3,fontSize:9,fontWeight:600,background:"rgba(0,230,118,0.05)",color:"#00e676",border:"1px solid rgba(0,230,118,0.12)"}}>ORGANIC</span>
            )}
          </div>
          <MiniChart data={token.price_history} width={500} height={55} staircase={token.staircase_detected}/>
        </div>

        {/* Metrics Grid */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:14}}>
          {[
            {l:"PRICE",v:"$"+fmtP(token.price)},{l:"MCAP",v:"$"+fmt(token.market_cap)},{l:"VOL 24H",v:"$"+fmt(token.volume_24h)},
            {l:"LIQUIDITY",v:"$"+fmt(token.liquidity)},{l:"HOLDERS",v:token.holders?.toLocaleString()||"?"},{l:"AGE",v:token.age_hours+"h"},
          ].map((m,i)=>(
            <div key={i} style={{background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.03)",borderRadius:3,padding:"8px 10px"}}>
              <div style={{fontSize:8,color:"#444",letterSpacing:"1px",fontWeight:600,marginBottom:3}}>{m.l}</div>
              <div style={{fontSize:13,color:"#e8eaed",fontWeight:700,fontFamily:"var(--f)"}}>{m.v}</div>
            </div>
          ))}
        </div>

        {/* Buy/Sell */}
        <div style={{marginBottom:14}}>
          <div style={{display:"flex",height:6,borderRadius:3,overflow:"hidden",background:"rgba(255,23,68,0.2)"}}>
            <div style={{width:`${br}%`,background:"#00e676",borderRadius:"3px 0 0 3px"}}/>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",marginTop:4,fontSize:9}}>
            <span style={{color:"#00e676",fontFamily:"var(--f)"}}>BUY {token.buys} ({br.toFixed(0)}%)</span>
            <span style={{color:"#ff1744",fontFamily:"var(--f)"}}>SELL {token.sells} ({(100-br).toFixed(0)}%)</span>
          </div>
        </div>

        {/* Security Audit */}
        <div style={{marginBottom:14}}>
          <div style={{fontSize:8,color:"#444",letterSpacing:"1.5px",fontWeight:700,marginBottom:8}}>SECURITY AUDIT</div>
          <div style={{display:"flex",flexDirection:"column",gap:4}}>
            {Object.entries(checks).map(([key,c],i)=>(
              <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 10px",borderRadius:3,background:c.pass?"rgba(0,230,118,0.025)":"rgba(255,23,68,0.025)",border:`1px solid ${c.pass?"rgba(0,230,118,0.06)":"rgba(255,23,68,0.06)"}`}}>
                <span style={{fontSize:10,color:c.pass?"#888":"#ff6d00"}}>{key.replace(/_/g," ").toUpperCase()}</span>
                <Badge ok={c.pass} label={String(c.value)}/>
              </div>
            ))}
          </div>
        </div>

        <button onClick={onClose} style={{width:"100%",padding:"9px",border:"1px solid rgba(255,255,255,0.06)",borderRadius:4,background:"rgba(255,255,255,0.02)",color:"#555",cursor:"pointer",fontSize:10,fontWeight:600,letterSpacing:"1px",fontFamily:"var(--f)"}}>CLOSE</button>
      </div>
    </div>
  );
}

// ─── ALERTS PANEL ───
function AlertsPanel({alerts,onClose}){
  const tc={safe:"#00e676",danger:"#ff1744",potential:"#00e5ff",graduation:"#ff9100",narrative:"#7c4dff"};
  return(
    <div style={{position:"fixed",inset:0,zIndex:1000,background:"rgba(0,0,0,0.88)",backdropFilter:"blur(10px)",display:"flex",alignItems:"center",justifyContent:"center",padding:12}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#080a0f",border:"1px solid rgba(255,255,255,0.05)",borderRadius:8,width:"100%",maxWidth:520,padding:22,maxHeight:"92vh",overflowY:"auto"}}>
        <div style={{fontSize:14,fontWeight:800,color:"#e8eaed",letterSpacing:"2px",marginBottom:14,fontFamily:"var(--f)"}}>ALERT LOG</div>
        <div style={{display:"flex",gap:6,marginBottom:12,flexWrap:"wrap"}}>
          {Object.entries(tc).map(([k,c])=>(<span key={k} style={{display:"flex",alignItems:"center",gap:4,fontSize:9,color:c}}><div style={{width:5,height:5,borderRadius:"50%",background:c}}/>{k.toUpperCase()}</span>))}
        </div>
        {alerts.length===0&&<div style={{textAlign:"center",padding:40,color:"#333",fontSize:11}}>No alerts yet. Waiting for scan results...</div>}
        <div style={{display:"flex",flexDirection:"column",gap:4}}>
          {alerts.map((a,i)=>(<div key={a.id||i} style={{display:"flex",alignItems:"center",gap:8,padding:"9px 12px",borderRadius:4,background:"rgba(255,255,255,0.012)",border:`1px solid ${tc[a.type]||"#555"}10`}}>
            <div style={{width:5,height:5,borderRadius:"50%",background:tc[a.type]||"#555",flexShrink:0}}/>
            <div style={{fontSize:10,color:"#444",fontFamily:"var(--f)",flexShrink:0,width:38}}>{a.time}</div>
            <div style={{fontSize:8,padding:"1px 5px",borderRadius:2,background:`${tc[a.type]||"#555"}12`,color:tc[a.type]||"#555",fontWeight:700,flexShrink:0,letterSpacing:"0.3px"}}>{a.type?.toUpperCase()}</div>
            <div style={{fontSize:11,fontWeight:700,color:"#e8eaed",fontFamily:"var(--f)",flexShrink:0,width:48}}>{a.symbol}</div>
            <div style={{fontSize:10,color:"#777",flex:1}}>{a.message}</div>
          </div>))}
        </div>
        <button onClick={onClose} style={{width:"100%",padding:"9px",border:"1px solid rgba(255,255,255,0.06)",borderRadius:4,background:"rgba(255,255,255,0.02)",color:"#555",cursor:"pointer",fontSize:10,fontWeight:600,letterSpacing:"1px",fontFamily:"var(--f)",marginTop:14}}>CLOSE</button>
      </div>
    </div>
  );
}

// ─── MAIN APP ───
export default function App(){
  const[tokens,setTokens]=useState([]);
  const[stats,setStatsData]=useState(null);
  const[alerts,setAlerts]=useState([]);
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState(null);
  const[sortBy,setSortBy]=useState("safety");
  const[sortDir,setSortDir]=useState("desc");
  const[minScore,setMinScore]=useState(0);
  const[selected,setSelected]=useState(null);
  const[showAlerts,setShowAlerts]=useState(false);
  const[tab,setTab]=useState("all");
  const[search,setSearch]=useState("");
  const[watchlist,setWatchlist]=useState([]);
  const[copied,setCopied]=useState(null);
  const[lastUpdate,setLastUpdate]=useState(null);

  // ─── DATA FETCHING ───
  const fetchData=useCallback(async()=>{
    try{
      const[tokensRes,statsRes,alertsRes]=await Promise.all([
        getTokens({sort:sortBy,dir:sortDir}),
        getStats(),
        getAlerts(),
      ]);
      setTokens(tokensRes.tokens||[]);
      setStatsData(statsRes);
      setAlerts(alertsRes.alerts||[]);
      setLastUpdate(new Date());
      setError(null);
      setLoading(false);
    }catch(err){
      setError(err.message);
      setLoading(false);
    }
  },[sortBy,sortDir]);

  useEffect(()=>{fetchData();const iv=setInterval(fetchData,15000);return()=>clearInterval(iv);},[fetchData]);

  const filtered=useMemo(()=>{
    let list=[...tokens];
    if(search){const q=search.toLowerCase();list=list.filter(t=>t.name?.toLowerCase().includes(q)||t.symbol?.toLowerCase().includes(q)||t.address?.toLowerCase().includes(q));}
    if(minScore>0)list=list.filter(t=>t.safety>=minScore);
    if(tab==="safe")list=list.filter(t=>t.safety>=75);
    if(tab==="potential")list=list.filter(t=>t.potential>=50&&t.safety>=50);
    if(tab==="danger")list=list.filter(t=>t.safety<25||t.staircase_detected);
    if(tab==="watchlist")list=list.filter(t=>watchlist.includes(t.address));
    return list;
  },[tokens,search,minScore,tab,watchlist]);

  const handleSort=(col)=>{if(sortBy===col)setSortDir(d=>d==="desc"?"asc":"desc");else{setSortBy(col);setSortDir("desc");}};
  const toggleWatch=useCallback((addr,e)=>{e.stopPropagation();setWatchlist(w=>w.includes(addr)?w.filter(x=>x!==addr):[...w,addr]);},[]);
  const copyAddr=useCallback((addr,e)=>{e.stopPropagation();navigator.clipboard.writeText(addr).catch(()=>{});setCopied(addr);setTimeout(()=>setCopied(null),1500);},[]);

  const SortIcon=({col})=>{if(sortBy!==col)return<span style={{color:"#1a1a1a",fontSize:8}}>↕</span>;return<span style={{color:"#00e5ff",fontSize:8}}>{sortDir==="desc"?"↓":"↑"}</span>;};

  const tabs=[
    {key:"all",label:"ALL",count:tokens.length,color:"#e8eaed"},
    {key:"safe",label:"SAFE",count:tokens.filter(t=>t.safety>=75).length,color:"#00e676"},
    {key:"potential",label:"x2 POT",count:tokens.filter(t=>t.potential>=50&&t.safety>=50).length,color:"#00e5ff"},
    {key:"danger",label:"DANGER",count:tokens.filter(t=>t.safety<25||t.staircase_detected).length,color:"#ff1744"},
    {key:"watchlist",label:"★ WATCH",count:watchlist.length,color:"#ffab00"},
  ];

  return(
    <div style={{minHeight:"100vh",background:"#060810",color:"#e8eaed",fontFamily:"'IBM Plex Mono', monospace",padding:14,boxSizing:"border-box"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600;700&display=swap');
        :root{--f:'IBM Plex Mono',monospace}*{box-sizing:border-box}
        ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:#080a0f}::-webkit-scrollbar-thumb{background:#151820;border-radius:2px}
        @keyframes pd{0%,100%{opacity:1}50%{opacity:.3}}
        @keyframes spin{to{transform:rotate(360deg)}}
      `}</style>

      {/* HEADER */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,paddingBottom:12,borderBottom:"1px solid rgba(255,255,255,0.025)",flexWrap:"wrap",gap:8}}>
        <div>
          <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:2}}>
            <div style={{width:6,height:6,borderRadius:"50%",background:error?"#ff1744":"#00e676",animation:error?"none":"pd 2s ease-in-out infinite",boxShadow:error?"none":"0 0 6px rgba(0,230,118,0.4)"}}/>
            <span style={{fontSize:14,fontWeight:700,letterSpacing:"2px"}}>SOLANA SCREENER</span>
            <span style={{fontSize:9,color:"#333",letterSpacing:"1px",marginLeft:4}}>LIVE</span>
          </div>
          <div style={{fontSize:8,color:"#222",letterSpacing:"1px"}}>
            {error?`CONNECTION ERROR: ${error}`:lastUpdate?`Last scan: ${lastUpdate.toLocaleTimeString("fr-FR")}`:"Connecting..."}
          </div>
        </div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          <button onClick={()=>setShowAlerts(true)} style={{padding:"4px 10px",border:"1px solid rgba(255,255,255,0.06)",borderRadius:3,background:"rgba(255,255,255,0.015)",color:"#666",cursor:"pointer",fontSize:9,fontWeight:600,letterSpacing:"1px",fontFamily:"var(--f)",display:"flex",alignItems:"center",gap:5}}>
            ALERTS {alerts.length>0&&<span style={{fontSize:8,padding:"0 4px",borderRadius:2,background:"rgba(255,23,68,0.12)",color:"#ff1744",fontWeight:700}}>{alerts.length}</span>}
          </button>
          <button onClick={fetchData} style={{padding:"4px 10px",border:"1px solid rgba(255,255,255,0.06)",borderRadius:3,background:"rgba(255,255,255,0.015)",color:"#666",cursor:"pointer",fontSize:9,fontWeight:600,letterSpacing:"1px",fontFamily:"var(--f)"}}>REFRESH</button>
        </div>
      </div>

      {/* STATS */}
      {stats&&(
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(110px, 1fr))",gap:6,marginBottom:12}}>
          {[
            {l:"SCANNED",v:stats.total,c:"#e8eaed"},
            {l:"AVG SCORE",v:stats.avgScore,c:getScoreColor(stats.avgScore)},
            {l:"RUG RATE",v:stats.rugRate+"%",c:stats.rugRate>30?"#ff1744":"#ffab00"},
            {l:"STAIRCASES",v:stats.stairs,c:"#ff1744"},
            {l:"BEST SAFETY",v:stats.bestSafety?stats.bestSafety.symbol+" ("+stats.bestSafety.score+")":"—",c:"#00e676"},
            {l:"SCANS",v:stats.scanCount,c:"#999"},
          ].map((s,i)=>(
            <div key={i} style={{background:"rgba(255,255,255,0.012)",border:"1px solid rgba(255,255,255,0.025)",borderRadius:4,padding:"8px 10px"}}>
              <div style={{fontSize:7,color:"#333",letterSpacing:"1px",fontWeight:600,marginBottom:3}}>{s.l}</div>
              <div style={{fontSize:12,color:s.c,fontWeight:700,fontFamily:"var(--f)"}}>{s.v}</div>
            </div>
          ))}
        </div>
      )}

      {/* SEARCH */}
      <div style={{marginBottom:10}}>
        <input type="text" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search by name, symbol, or address..."
          style={{width:"100%",maxWidth:360,padding:"7px 12px",background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.05)",borderRadius:4,color:"#e8eaed",fontSize:11,fontFamily:"var(--f)",outline:"none"}}/>
      </div>

      {/* TABS */}
      <div style={{display:"flex",gap:3,marginBottom:10,flexWrap:"wrap"}}>
        {tabs.map(t=>(
          <button key={t.key} onClick={()=>setTab(t.key)} style={{padding:"4px 12px",border:"1px solid",borderColor:tab===t.key?t.color+"33":"rgba(255,255,255,0.03)",borderRadius:3,background:tab===t.key?t.color+"08":"transparent",color:tab===t.key?t.color:"#333",cursor:"pointer",fontSize:9,fontWeight:600,letterSpacing:"0.5px",fontFamily:"var(--f)",display:"flex",alignItems:"center",gap:5}}>
            {t.label}<span style={{fontSize:8,padding:"0 4px",borderRadius:2,background:tab===t.key?t.color+"12":"rgba(255,255,255,0.02)",color:tab===t.key?t.color:"#222"}}>{t.count}</span>
          </button>
        ))}
      </div>

      {/* MIN SCORE */}
      <div style={{display:"flex",gap:3,marginBottom:12,alignItems:"center"}}>
        <span style={{fontSize:8,color:"#222",letterSpacing:"1px",marginRight:3}}>MIN SAFETY</span>
        {[0,25,50,75].map(s=>(
          <button key={s} onClick={()=>setMinScore(s)} style={{padding:"3px 9px",border:"1px solid",borderColor:minScore===s?"rgba(0,230,118,0.2)":"rgba(255,255,255,0.03)",borderRadius:3,background:minScore===s?"rgba(0,230,118,0.05)":"transparent",color:minScore===s?"#00e676":"#333",cursor:"pointer",fontSize:9,fontWeight:600,fontFamily:"var(--f)"}}>{s===0?"ALL":s+"+"}</button>
        ))}
      </div>

      {/* LOADING STATE */}
      {loading&&(
        <div style={{textAlign:"center",padding:60}}>
          <div style={{width:24,height:24,border:"2px solid rgba(255,255,255,0.1)",borderTopColor:"#00e5ff",borderRadius:"50%",animation:"spin 1s linear infinite",margin:"0 auto 12px"}}/>
          <div style={{fontSize:11,color:"#444",letterSpacing:"1px"}}>SCANNING SOLANA NETWORK...</div>
        </div>
      )}

      {/* TABLE */}
      {!loading&&(
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:10}}>
            <thead>
              <tr style={{borderBottom:"1px solid rgba(255,255,255,0.03)"}}>
                <th style={{width:30,padding:"7px 4px"}}></th>
                {[
                  {k:"safety",l:"SAFE",w:72},{k:"potential",l:"x2 POT",w:72},
                  {k:"name",l:"TOKEN",w:110},{k:null,l:"CHART",w:130},
                  {k:"price",l:"PRICE",w:85},{k:"change_24h",l:"24H",w:58},
                  {k:"market_cap",l:"MCAP",w:68},{k:"volume_24h",l:"VOL",w:68},
                  {k:"liquidity",l:"LIQ",w:60},{k:null,l:"FLAGS",w:90},{k:null,l:"",w:30},
                ].map((c,i)=>(
                  <th key={i} onClick={()=>c.k&&handleSort(c.k)} style={{textAlign:"left",padding:"7px 5px",fontSize:8,fontWeight:700,letterSpacing:"1px",color:sortBy===c.k?"#00e5ff":"#222",cursor:c.k?"pointer":"default",whiteSpace:"nowrap",userSelect:"none",width:c.w}}>
                    {c.l} {c.k&&<SortIcon col={c.k}/>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(token=>{
                const isW=watchlist.includes(token.address);
                return(
                  <tr key={token.address||token.id} onClick={()=>setSelected(token)} style={{borderBottom:"1px solid rgba(255,255,255,0.012)",cursor:"pointer",transition:"background 0.1s",background:isW?"rgba(255,171,0,0.02)":"transparent"}}
                    onMouseEnter={e=>e.currentTarget.style.background=isW?"rgba(255,171,0,0.04)":"rgba(255,255,255,0.012)"}
                    onMouseLeave={e=>e.currentTarget.style.background=isW?"rgba(255,171,0,0.02)":"transparent"}>
                    <td style={{padding:"7px 4px",textAlign:"center"}}><span onClick={e=>toggleWatch(token.address,e)} style={{cursor:"pointer",fontSize:13,color:isW?"#ffab00":"#1a1a1a",transition:"color 0.15s"}}>★</span></td>
                    <td style={{padding:"7px 5px"}}><ScoreBar score={token.safety}/></td>
                    <td style={{padding:"7px 5px"}}><ScoreBar score={token.potential} color={getPotColor(token.potential)}/></td>
                    <td style={{padding:"7px 5px"}}><div style={{fontWeight:700,color:"#e8eaed",fontSize:11}}>{token.symbol}</div><div style={{fontSize:8,color:"#222"}}>{token.address?.slice(0,8)}...</div></td>
                    <td style={{padding:"7px 5px"}}><MiniChart data={token.price_history} staircase={token.staircase_detected}/></td>
                    <td style={{padding:"7px 5px",color:"#aaa",fontFamily:"var(--f)"}}>${fmtP(token.price)}</td>
                    <td style={{padding:"7px 5px",fontWeight:700,fontFamily:"var(--f)",color:token.change_24h>=0?"#00e676":"#ff1744",fontSize:10}}>{token.change_24h>=0?"+":""}{token.change_24h?.toFixed(1)||0}%</td>
                    <td style={{padding:"7px 5px",color:"#666",fontFamily:"var(--f)"}}>${fmt(token.market_cap)}</td>
                    <td style={{padding:"7px 5px",color:"#666",fontFamily:"var(--f)"}}>${fmt(token.volume_24h)}</td>
                    <td style={{padding:"7px 5px",color:token.liquidity<5000?"#ff6d00":"#666",fontFamily:"var(--f)"}}>${fmt(token.liquidity)}</td>
                    <td style={{padding:"7px 5px"}}>
                      <div style={{display:"flex",gap:2,flexWrap:"wrap"}}>
                        {token.staircase_detected&&<span style={{padding:"1px 4px",borderRadius:2,fontSize:7,fontWeight:800,background:"rgba(255,23,68,0.1)",color:"#ff1744",border:"1px solid rgba(255,23,68,0.2)"}}>STAIRS</span>}
                        {token.rugcheck?.mintEnabled&&<span style={{padding:"1px 4px",borderRadius:2,fontSize:7,fontWeight:700,background:"rgba(255,23,68,0.08)",color:"#ff1744",border:"1px solid rgba(255,23,68,0.15)"}}>MINT</span>}
                        {token.rugcheck?.freezeEnabled&&<span style={{padding:"1px 4px",borderRadius:2,fontSize:7,fontWeight:700,background:"rgba(255,109,0,0.08)",color:"#ff6d00",border:"1px solid rgba(255,109,0,0.15)"}}>FREEZE</span>}
                        {token.safety>=75&&!token.staircase_detected&&<span style={{padding:"1px 4px",borderRadius:2,fontSize:7,fontWeight:700,background:"rgba(0,230,118,0.06)",color:"#00e676",border:"1px solid rgba(0,230,118,0.12)"}}>OK</span>}
                      </div>
                    </td>
                    <td style={{padding:"7px 4px",textAlign:"center"}}><span onClick={e=>copyAddr(token.address,e)} title="Copy address" style={{cursor:"pointer",fontSize:11,color:copied===token.address?"#00e676":"#222",transition:"color 0.15s"}}>{copied===token.address?"✓":"⊕"}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!loading&&filtered.length===0&&(
        <div style={{textAlign:"center",padding:"40px 20px",color:"#1a1a1a",fontSize:10,letterSpacing:"1px"}}>
          {tab==="watchlist"?"NO TOKENS IN WATCHLIST":tokens.length===0?"WAITING FOR FIRST SCAN...":"NO TOKENS MATCH FILTERS"}
        </div>
      )}

      {/* FOOTER */}
      <div style={{marginTop:14,padding:"8px 0",borderTop:"1px solid rgba(255,255,255,0.02)",display:"flex",justifyContent:"space-between",fontSize:8,color:"#1a1a1a",letterSpacing:"1px"}}>
        <span>LIVE DATA . SOLANA NETWORK</span>
        <span>{tokens.length} TOKENS TRACKED</span>
      </div>

      {/* MODALS */}
      {selected&&<TokenDetail token={selected} onClose={()=>setSelected(null)}/>}
      {showAlerts&&<AlertsPanel alerts={alerts} onClose={()=>setShowAlerts(false)}/>}
    </div>
  );
}
