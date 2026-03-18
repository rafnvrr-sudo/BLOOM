import { useState, useMemo, useEffect, useCallback } from "react";
import { getTokens, getAlerts, getStats, getHealth, pingBackend } from "./api.js";

function getScoreColor(s){return s>=75?"#16a34a":s>=50?"#d97706":s>=25?"#ea580c":"#dc2626";}
function getScoreBg(s){return s>=75?"#dcfce7":s>=50?"#fef3c7":s>=25?"#ffedd5":"#fee2e2";}
function getPotColor(p){return p>=70?"#2563eb":p>=50?"#7c3aed":p>=30?"#d97706":"#9ca3af";}
function getPotBg(p){return p>=70?"#dbeafe":p>=50?"#ede9fe":p>=30?"#fef3c7":"#f3f4f6";}
function getScoreLabel(s){return s>=75?"Safe":s>=50?"Caution":s>=25?"Risky":"Danger";}
function getPotLabel(p){return p>=70?"High x2":p>=50?"Moderate":p>=30?"Low":"Minimal";}
function fmt(n){if(!n)return"0";return n>=1e6?(n/1e6).toFixed(2)+"M":n>=1e3?(n/1e3).toFixed(1)+"K":n.toString();}
function fmtP(p){if(!p)return"$0";return p<.0001?p.toExponential(2):p<1?p.toFixed(6):p.toFixed(4);}

function ScoreBadge({score,type}){
  const c=type==="safety"?getScoreColor(score):getPotColor(score);
  const bg=type==="safety"?getScoreBg(score):getPotBg(score);
  const lb=type==="safety"?getScoreLabel(score):getPotLabel(score);
  return(<div style={{display:"flex",alignItems:"center",gap:5}}><span style={{fontSize:13,fontWeight:700,color:c}}>{score}</span><span style={{fontSize:9,fontWeight:600,color:c,background:bg,padding:"2px 7px",borderRadius:12}}>{lb}</span></div>);
}

function MiniChart({data,width=110,height=28,bad}){
  if(!data||data.length<2)return <div style={{width,height,background:"#f1f5f9",borderRadius:6}}/>;
  const f=data.filter(v=>v>0);if(f.length<2)return null;
  const mn=Math.min(...f),mx=Math.max(...f),r=mx-mn||1;
  const pts=f.map((v,i)=>`${(i/(f.length-1))*width},${height-((v-mn)/r)*(height-4)-2}`).join(" ");
  const col=bad?"#dc2626":"#16a34a";
  return(<svg width={width} height={height} style={{display:"block"}}><defs><linearGradient id={"cg"+(bad?1:0)} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={col} stopOpacity="0.15"/><stop offset="100%" stopColor={col} stopOpacity="0"/></linearGradient></defs><polygon points={`0,${height} ${pts} ${width},${height}`} fill={"url(#cg"+(bad?1:0)+")"}/><polyline points={pts} fill="none" stroke={col} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.8"/></svg>);
}

function FlagBadge({label,type}){
  const s={danger:{bg:"#fee2e2",color:"#dc2626",border:"#fecaca"},warn:{bg:"#ffedd5",color:"#ea580c",border:"#fed7aa"},ok:{bg:"#dcfce7",color:"#16a34a",border:"#bbf7d0"}}[type||"danger"];
  return <span style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:12,background:s.bg,color:s.color,border:"1px solid "+s.border}}>{label}</span>;
}

function Badge({ok,label}){return(<span style={{display:"inline-block",padding:"2px 7px",borderRadius:8,fontSize:10,fontWeight:600,background:ok?"#dcfce7":"#fee2e2",color:ok?"#16a34a":"#dc2626"}}>{ok?"✓":"✗"} {label}</span>);}

function StatCard({label,value,color}){
  return(<div style={{background:"#fff",borderRadius:12,padding:"16px 20px",border:"1px solid #e2e8f0"}}>
    <div style={{fontSize:12,color:"#64748b",marginBottom:4}}>{label}</div>
    <div style={{fontSize:20,fontWeight:700,color:color||"#1e293b"}}>{value}</div>
  </div>);
}

function TokenDetail({token,onClose}){
  const br=token.buys/(Math.max(token.buys+token.sells,1))*100;
  const checks=token.safety_checks||{};
  return(
    <div style={{position:"fixed",inset:0,zIndex:1000,background:"rgba(15,23,42,0.5)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#fff",borderRadius:16,width:"100%",maxWidth:560,padding:28,maxHeight:"90vh",overflowY:"auto",boxShadow:"0 25px 50px rgba(0,0,0,0.15)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20}}>
          <div><div style={{fontSize:11,color:"#94a3b8",marginBottom:4,wordBreak:"break-all"}}>{token.address}</div><div style={{fontSize:20,fontWeight:700,color:"#1e293b"}}>{token.name} <span style={{color:"#94a3b8",fontWeight:400,fontSize:14}}>/ {token.symbol}</span></div></div>
          <div style={{display:"flex",gap:12}}><div style={{textAlign:"center"}}><div style={{fontSize:9,color:"#94a3b8",textTransform:"uppercase",letterSpacing:1,marginBottom:2}}>Safety</div><ScoreBadge score={token.safety} type="safety"/></div><div style={{textAlign:"center"}}><div style={{fontSize:9,color:"#94a3b8",textTransform:"uppercase",letterSpacing:1,marginBottom:2}}>Potential</div><ScoreBadge score={token.potential} type="potential"/></div></div>
        </div>
        <div style={{display:"flex",gap:6,marginBottom:16,flexWrap:"wrap"}}>
          {[{l:"DEX Screener",u:token.url||"https://dexscreener.com/solana/"+token.pair_address},{l:"Birdeye",u:"https://birdeye.so/token/"+token.address+"?chain=solana"},{l:"Solscan",u:"https://solscan.io/token/"+token.address},{l:"rugcheck",u:"https://rugcheck.xyz/tokens/"+token.address}].map((lk,i)=>(<a key={i} href={lk.u} target="_blank" rel="noopener noreferrer" style={{padding:"5px 12px",borderRadius:8,fontSize:11,fontWeight:500,background:"#f8fafc",color:"#475569",border:"1px solid #e2e8f0",textDecoration:"none"}}>{lk.l} ↗</a>))}
        </div>
        <div style={{background:"#f8fafc",borderRadius:12,padding:14,marginBottom:16,border:"1px solid #e2e8f0"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <span style={{fontSize:11,fontWeight:600,color:"#64748b",textTransform:"uppercase",letterSpacing:1}}>Price action</span>
            {token.staircase_detected?<FlagBadge label={"Staircase "+token.staircase_confidence+"%"} type="danger"/>:<FlagBadge label="Organic" type="ok"/>}
          </div>
          <MiniChart data={token.price_history} width={490} height={55} bad={token.staircase_detected}/>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:16}}>
          {[{l:"Price",v:"$"+fmtP(token.price)},{l:"MCap",v:"$"+fmt(token.market_cap)},{l:"Vol 24H",v:"$"+fmt(token.volume_24h)},{l:"Liquidity",v:"$"+fmt(token.liquidity)},{l:"Holders",v:(token.holders||"?").toLocaleString()},{l:"Age",v:token.age_hours+"h"}].map((m,i)=>(<div key={i} style={{background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:10,padding:"10px 12px"}}><div style={{fontSize:9,color:"#94a3b8",fontWeight:600,textTransform:"uppercase",marginBottom:2}}>{m.l}</div><div style={{fontSize:14,color:"#1e293b",fontWeight:700}}>{m.v}</div></div>))}
        </div>
        {/* Honeypot warning */}
        {token.honeypot_detected&&(
          <div style={{background:"#fef2f2",border:"2px solid #fecaca",borderRadius:12,padding:"14px 18px",marginBottom:16,display:"flex",alignItems:"center",gap:12}}>
            <span style={{fontSize:24}}>⚠️</span>
            <div><div style={{fontSize:14,fontWeight:700,color:"#991b1b"}}>HONEYPOT DETECTED</div><div style={{fontSize:12,color:"#dc2626",marginTop:2}}>This token cannot be sold or has extreme sell tax. Do NOT buy.</div></div>
          </div>
        )}
        {/* Jupiter slippage & tax */}
        {(token.buy_slippage!=null||token.sell_tax!=null)&&(
          <div style={{background:"#f8fafc",borderRadius:12,padding:14,marginBottom:16,border:"1px solid #e2e8f0"}}>
            <div style={{fontSize:11,fontWeight:600,color:"#64748b",textTransform:"uppercase",letterSpacing:1,marginBottom:10}}>Swap simulation (Jupiter)</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
              {token.buy_slippage!=null&&(
                <div style={{background:token.buy_slippage<5?"#f0fdf4":"#fef2f2",borderRadius:8,padding:"8px 12px",border:"1px solid "+(token.buy_slippage<5?"#bbf7d0":"#fecaca")}}>
                  <div style={{fontSize:9,color:"#64748b",marginBottom:2}}>BUY SLIPPAGE</div>
                  <div style={{fontSize:15,fontWeight:700,color:token.buy_slippage<5?"#16a34a":token.buy_slippage<10?"#d97706":"#dc2626"}}>{token.buy_slippage.toFixed(1)}%</div>
                </div>
              )}
              {token.sell_slippage!=null&&(
                <div style={{background:token.sell_slippage<8?"#f0fdf4":"#fef2f2",borderRadius:8,padding:"8px 12px",border:"1px solid "+(token.sell_slippage<8?"#bbf7d0":"#fecaca")}}>
                  <div style={{fontSize:9,color:"#64748b",marginBottom:2}}>SELL SLIPPAGE</div>
                  <div style={{fontSize:15,fontWeight:700,color:token.sell_slippage<8?"#16a34a":token.sell_slippage<15?"#d97706":"#dc2626"}}>{token.sell_slippage.toFixed(1)}%</div>
                </div>
              )}
              {token.sell_tax!=null&&(
                <div style={{background:token.sell_tax<5?"#f0fdf4":token.sell_tax<15?"#fef3c7":"#fef2f2",borderRadius:8,padding:"8px 12px",border:"1px solid "+(token.sell_tax<5?"#bbf7d0":token.sell_tax<15?"#fde68a":"#fecaca")}}>
                  <div style={{fontSize:9,color:"#64748b",marginBottom:2}}>SELL TAX</div>
                  <div style={{fontSize:15,fontWeight:700,color:token.sell_tax<5?"#16a34a":token.sell_tax<15?"#d97706":"#dc2626"}}>{token.sell_tax.toFixed(1)}%</div>
                </div>
              )}
            </div>
          </div>
        )}
        <div style={{marginBottom:16}}><div style={{display:"flex",height:8,borderRadius:4,overflow:"hidden",background:"#fee2e2"}}><div style={{width:br+"%",background:"#16a34a",borderRadius:"4px 0 0 4px"}}/></div><div style={{display:"flex",justifyContent:"space-between",marginTop:4,fontSize:11}}><span style={{color:"#16a34a",fontWeight:600}}>Buy {token.buys} ({br.toFixed(0)}%)</span><span style={{color:"#dc2626",fontWeight:600}}>Sell {token.sells} ({(100-br).toFixed(0)}%)</span></div></div>
        <div style={{marginBottom:16}}><div style={{fontSize:11,fontWeight:600,color:"#64748b",textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Security audit</div><div style={{display:"flex",flexDirection:"column",gap:4}}>{Object.entries(checks).map(([k,c],i)=>(<div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 12px",borderRadius:8,background:c.pass?"#f0fdf4":"#fef2f2",border:"1px solid "+(c.pass?"#bbf7d0":"#fecaca")}}><span style={{fontSize:11,color:c.pass?"#166534":"#991b1b",fontWeight:500}}>{k.replace(/_/g," ").toUpperCase()}</span><Badge ok={c.pass} label={String(c.value)}/></div>))}</div></div>
        <button onClick={onClose} style={{width:"100%",padding:11,borderRadius:10,border:"1px solid #e2e8f0",background:"#f8fafc",color:"#64748b",cursor:"pointer",fontSize:13,fontWeight:600}}>Close</button>
      </div>
    </div>
  );
}

function AlertsPanel({alerts,onClose}){
  const tc={safe:"#16a34a",danger:"#dc2626",potential:"#2563eb",graduation:"#ea580c",narrative:"#7c3aed"};
  const tbg={safe:"#dcfce7",danger:"#fee2e2",potential:"#dbeafe",graduation:"#ffedd5",narrative:"#ede9fe"};
  return(
    <div style={{position:"fixed",inset:0,zIndex:1000,background:"rgba(15,23,42,0.5)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#fff",borderRadius:16,width:"100%",maxWidth:540,padding:24,maxHeight:"90vh",overflowY:"auto",boxShadow:"0 25px 50px rgba(0,0,0,0.15)"}}>
        <div style={{fontSize:18,fontWeight:700,color:"#1e293b",marginBottom:16}}>Alert Log</div>
        {alerts.length===0&&<div style={{textAlign:"center",padding:40,color:"#94a3b8",fontSize:13}}>No alerts yet.</div>}
        <div style={{display:"flex",flexDirection:"column",gap:6}}>{alerts.map((a,i)=>(<div key={a.id||i} style={{display:"flex",alignItems:"center",gap:8,padding:"10px 14px",borderRadius:10,background:"#f8fafc",border:"1px solid #e2e8f0"}}><div style={{width:7,height:7,borderRadius:"50%",background:tc[a.type]||"#94a3b8",flexShrink:0}}/><span style={{fontSize:11,color:"#94a3b8",flexShrink:0,width:38}}>{a.time}</span><span style={{fontSize:9,fontWeight:600,padding:"2px 7px",borderRadius:10,background:tbg[a.type]||"#f3f4f6",color:tc[a.type]||"#64748b",flexShrink:0}}>{(a.type||"").toUpperCase()}</span>{a.symbol&&a.symbol!=="—"&&<span style={{fontSize:12,fontWeight:700,color:"#1e293b",flexShrink:0,width:50}}>{a.symbol}</span>}<span style={{fontSize:11,color:"#64748b",flex:1}}>{a.message}</span></div>))}</div>
        <button onClick={onClose} style={{width:"100%",padding:11,borderRadius:10,border:"1px solid #e2e8f0",background:"#f8fafc",color:"#64748b",cursor:"pointer",fontSize:13,fontWeight:600,marginTop:14}}>Close</button>
      </div>
    </div>
  );
}

function Sidebar({collapsed,setCollapsed,tab,setTab,stats}){
  const items=[{key:"all",label:"Dashboard",d:"M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"},{key:"safe",label:"Safe Tokens",d:"M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"},{key:"potential",label:"x2 Potential",d:"M13 10V3L4 14h7v7l9-11h-7z"},{key:"danger",label:"Danger Zone",d:"M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"},{key:"watchlist",label:"Watchlist",d:"M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"}];
  return(
    <aside style={{width:collapsed?60:230,background:"#fff",borderRight:"1px solid #e2e8f0",height:"100vh",display:"flex",flexDirection:"column",transition:"width 0.2s",flexShrink:0,overflow:"hidden"}}>
      <div style={{height:56,display:"flex",alignItems:"center",padding:"0 14px",borderBottom:"1px solid #e2e8f0"}}>
        {!collapsed&&<div style={{display:"flex",alignItems:"center",gap:8}}><div style={{width:30,height:30,borderRadius:8,background:"#2563eb",display:"flex",alignItems:"center",justifyContent:"center"}}><span style={{color:"#fff",fontWeight:700,fontSize:13}}>B</span></div><div><div style={{fontWeight:700,fontSize:15,color:"#1e293b"}}>BLOOM</div><div style={{fontSize:9,color:"#94a3b8",marginTop:-2}}>Solana Screener</div></div></div>}
        <button onClick={()=>setCollapsed(!collapsed)} style={{marginLeft:"auto",padding:4,borderRadius:6,border:"none",background:"transparent",cursor:"pointer",color:"#94a3b8",display:"flex"}}><svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={collapsed?"M13 5l7 7-7 7M5 5l7 7-7 7":"M11 19l-7-7 7-7m8 14l-7-7 7-7"}/></svg></button>
      </div>
      <nav style={{flex:1,padding:"10px 6px",overflowY:"auto"}}>
        {!collapsed&&<div style={{padding:"0 10px",marginBottom:6,fontSize:9,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:1.5}}>Scanner</div>}
        <div style={{display:"flex",flexDirection:"column",gap:2}}>{items.map(it=>{const a=tab===it.key;return(<button key={it.key} onClick={()=>setTab(it.key)} title={collapsed?it.label:undefined} style={{display:"flex",alignItems:"center",gap:9,padding:collapsed?"9px":"9px 10px",borderRadius:8,border:"none",background:a?"#eff6ff":"transparent",color:a?"#2563eb":"#64748b",cursor:"pointer",fontSize:12,fontWeight:a?600:500,width:"100%",textAlign:"left",justifyContent:collapsed?"center":"flex-start"}}><svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={it.d}/></svg>{!collapsed&&it.label}</button>);})}</div>
      </nav>
      <div style={{borderTop:"1px solid #e2e8f0",padding:10}}>{!collapsed?<div style={{display:"flex",justifyContent:"space-between",fontSize:10}}><span style={{color:"#94a3b8"}}>Tracked</span><span style={{fontWeight:700,color:"#1e293b"}}>{stats?.total||0}</span></div>:<div style={{textAlign:"center",fontSize:13,fontWeight:700,color:"#1e293b"}}>{stats?.total||0}</div>}</div>
    </aside>
  );
}

function HealthPanel({health,onClose}){
  const statusColor={ok:"#16a34a",degraded:"#d97706",down:"#dc2626",unknown:"#94a3b8"};
  const statusBg={ok:"#dcfce7",degraded:"#fef3c7",down:"#fee2e2",unknown:"#f3f4f6"};
  return(
    <div style={{position:"fixed",inset:0,zIndex:1000,background:"rgba(15,23,42,0.5)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#fff",borderRadius:16,width:"100%",maxWidth:480,padding:24,maxHeight:"90vh",overflowY:"auto",boxShadow:"0 25px 50px rgba(0,0,0,0.15)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
          <div style={{fontSize:18,fontWeight:700,color:"#1e293b"}}>System Status</div>
          {health&&<span style={{fontSize:12,fontWeight:600,padding:"4px 12px",borderRadius:12,background:health.status==="healthy"?"#dcfce7":health.status==="degraded"?"#fef3c7":"#fee2e2",color:health.status==="healthy"?"#16a34a":health.status==="degraded"?"#d97706":"#dc2626"}}>{health.status?.toUpperCase()}</span>}
        </div>
        {!health&&<div style={{textAlign:"center",padding:40,color:"#94a3b8",fontSize:13}}>Loading health data...</div>}
        {health&&<>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:18}}>
            <div style={{background:"#f8fafc",borderRadius:10,padding:"10px 14px",border:"1px solid #e2e8f0"}}><div style={{fontSize:10,color:"#94a3b8",marginBottom:2}}>UPTIME</div><div style={{fontSize:15,fontWeight:700,color:"#1e293b"}}>{health.uptime?Math.floor(health.uptime/60)+"m":"?"}</div></div>
            <div style={{background:"#f8fafc",borderRadius:10,padding:"10px 14px",border:"1px solid #e2e8f0"}}><div style={{fontSize:10,color:"#94a3b8",marginBottom:2}}>SCANS</div><div style={{fontSize:15,fontWeight:700,color:"#1e293b"}}>{health.scans||0}</div></div>
            <div style={{background:"#f8fafc",borderRadius:10,padding:"10px 14px",border:"1px solid #e2e8f0"}}><div style={{fontSize:10,color:"#94a3b8",marginBottom:2}}>TOKENS</div><div style={{fontSize:15,fontWeight:700,color:"#1e293b"}}>{health.tokens||0}</div></div>
          </div>
          <div style={{fontSize:12,fontWeight:600,color:"#64748b",textTransform:"uppercase",letterSpacing:1,marginBottom:10}}>Services</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {health.services&&Object.entries(health.services).map(([name,svc])=>{
              const st=svc.status||"unknown";
              return(
                <div key={name} style={{background:"#f8fafc",borderRadius:10,padding:14,border:"1px solid #e2e8f0"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <div style={{width:9,height:9,borderRadius:"50%",background:statusColor[st]}}/>
                      <span style={{fontSize:14,fontWeight:600,color:"#1e293b",textTransform:"capitalize"}}>{name}</span>
                    </div>
                    <span style={{fontSize:11,fontWeight:600,padding:"2px 10px",borderRadius:12,background:statusBg[st],color:statusColor[st]}}>{st.toUpperCase()}</span>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
                    <div style={{fontSize:11,color:"#64748b"}}>Latency: <span style={{fontWeight:600,color:svc.latency>2000?"#dc2626":svc.latency>500?"#d97706":"#1e293b"}}>{svc.latency||0}ms</span></div>
                    <div style={{fontSize:11,color:"#64748b"}}>Errors: <span style={{fontWeight:600,color:svc.errorCount>0?"#dc2626":"#1e293b"}}>{svc.errorCount||0}</span></div>
                    {svc.lastSuccess&&<div style={{fontSize:11,color:"#64748b"}}>Last OK: <span style={{fontWeight:600,color:"#1e293b"}}>{svc.sinceLastSuccess!=null?svc.sinceLastSuccess+"s ago":"?"}</span></div>}
                    {svc.pairsReturned!=null&&<div style={{fontSize:11,color:"#64748b"}}>Pairs: <span style={{fontWeight:600,color:"#1e293b"}}>{svc.pairsReturned}</span></div>}
                    {svc.checksCompleted!=null&&<div style={{fontSize:11,color:"#64748b"}}>Checks: <span style={{fontWeight:600,color:"#1e293b"}}>{svc.checksCompleted}</span></div>}
                    {svc.alertsSent!=null&&<div style={{fontSize:11,color:"#64748b"}}>Sent: <span style={{fontWeight:600,color:"#1e293b"}}>{svc.alertsSent}</span></div>}
                  </div>
                </div>
              );
            })}
          </div>
          {health.lastScan&&<div style={{marginTop:12,fontSize:11,color:"#94a3b8",textAlign:"center"}}>Last scan: {new Date(health.lastScan).toLocaleTimeString("fr-FR")} ({health.sinceLastScan}s ago)</div>}
        </>}
        <button onClick={onClose} style={{width:"100%",padding:11,borderRadius:10,border:"1px solid #e2e8f0",background:"#f8fafc",color:"#64748b",cursor:"pointer",fontSize:13,fontWeight:600,marginTop:14}}>Close</button>
      </div>
    </div>
  );
}

export default function App(){
  const[tokens,setTokens]=useState([]);const[stats,setStatsData]=useState(null);const[alerts,setAlerts]=useState([]);const[loading,setLoading]=useState(true);const[error,setError]=useState(null);
  const[sortBy,setSortBy]=useState("safety");const[sortDir,setSortDir]=useState("desc");const[minScore,setMinScore]=useState(0);const[selected,setSelected]=useState(null);const[showAlerts,setShowAlerts]=useState(false);
  const[tab,setTab]=useState("all");const[search,setSearch]=useState("");const[watchlist,setWatchlist]=useState([]);const[copied,setCopied]=useState(null);const[lastUpdate,setLastUpdate]=useState(null);const[collapsed,setCollapsed]=useState(false);
  const[health,setHealth]=useState(null);const[showHealth,setShowHealth]=useState(false);const[backendAwake,setBackendAwake]=useState(false);

  // Auto-ping backend on page load to wake Render from cold start
  useEffect(()=>{
    let attempts=0;
    const wake=async()=>{
      const ok=await pingBackend();
      if(ok){setBackendAwake(true);return;}
      attempts++;
      if(attempts<10)setTimeout(wake,3000); // retry every 3s up to 10 times
    };
    wake();
  },[]);

  const fetchData=useCallback(async()=>{
    try{
      const[t,s,a,h]=await Promise.all([getTokens({sort:sortBy,dir:sortDir}),getStats(),getAlerts(),getHealth().catch(()=>null)]);
      setTokens(t.tokens||[]);setStatsData(s);setAlerts(a.alerts||[]);if(h)setHealth(h);
      setLastUpdate(new Date());setError(null);setLoading(false);setBackendAwake(true);
    }catch(e){setError(e.message);setLoading(false);}
  },[sortBy,sortDir]);

  useEffect(()=>{if(backendAwake){fetchData();const iv=setInterval(fetchData,15000);return()=>clearInterval(iv);}},[fetchData,backendAwake]);

  const filtered=useMemo(()=>{let l=[...tokens];if(search){const q=search.toLowerCase();l=l.filter(t=>t.name?.toLowerCase().includes(q)||t.symbol?.toLowerCase().includes(q)||t.address?.toLowerCase().includes(q));}if(minScore>0)l=l.filter(t=>t.safety>=minScore);if(tab==="safe")l=l.filter(t=>t.safety>=75);if(tab==="potential")l=l.filter(t=>t.potential>=50&&t.safety>=50);if(tab==="danger")l=l.filter(t=>t.safety<25||t.staircase_detected||t.honeypot_detected||t.sell_tax>15);if(tab==="watchlist")l=l.filter(t=>watchlist.includes(t.address));return l;},[tokens,search,minScore,tab,watchlist]);
  const handleSort=(c)=>{if(sortBy===c)setSortDir(d=>d==="desc"?"asc":"desc");else{setSortBy(c);setSortDir("desc");}};
  const toggleWatch=useCallback((a,e)=>{e.stopPropagation();setWatchlist(w=>w.includes(a)?w.filter(x=>x!==a):[...w,a]);},[]);
  const copyAddr=useCallback((a,e)=>{e.stopPropagation();navigator.clipboard.writeText(a).catch(()=>{});setCopied(a);setTimeout(()=>setCopied(null),1500);},[]);

  const SortTh=({col,label,w})=>(<th onClick={()=>handleSort(col)} style={{textAlign:"left",padding:"10px 8px",fontSize:10,fontWeight:600,color:sortBy===col?"#2563eb":"#94a3b8",cursor:"pointer",whiteSpace:"nowrap",userSelect:"none",width:w,textTransform:"uppercase",letterSpacing:0.5}}>{label} {sortBy===col&&(sortDir==="desc"?"↓":"↑")}</th>);
  const tabLabels={all:"All Tokens",safe:"Safe Tokens",potential:"x2 Potential",danger:"Danger Zone",watchlist:"Watchlist"};

  return(
    <div style={{display:"flex",height:"100vh",overflow:"hidden",background:"#f1f5f9",fontFamily:"'DM Sans',sans-serif"}}>
      <style>{"@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');:root{--f:'DM Sans',sans-serif}*{box-sizing:border-box;margin:0;padding:0}::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:3px}@keyframes spin{to{transform:rotate(360deg)}}"}</style>
      <Sidebar collapsed={collapsed} setCollapsed={setCollapsed} tab={tab} setTab={setTab} stats={stats}/>
      <main style={{flex:1,overflowY:"auto",padding:24}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
          <div>
            <h1 style={{fontSize:22,fontWeight:700,color:"#1e293b",margin:0}}>{tabLabels[tab]}</h1>
            <div style={{display:"flex",alignItems:"center",gap:8,marginTop:3}}>
              <p style={{fontSize:13,color:"#94a3b8",margin:0}}>{!backendAwake?"Waking up backend...":error?"Error: "+error:lastUpdate?"Last scan: "+lastUpdate.toLocaleTimeString("fr-FR"):"Connecting..."}</p>
              {health&&health.services&&(
                <div style={{display:"flex",gap:4,alignItems:"center"}}>
                  {Object.entries(health.services).map(([name,svc])=>{
                    const col=svc.status==="ok"?"#16a34a":svc.status==="degraded"?"#d97706":"#dc2626";
                    return <div key={name} title={name+": "+svc.status+(svc.latency?" ("+svc.latency+"ms)":"")} style={{width:7,height:7,borderRadius:"50%",background:col}}/>;
                  })}
                </div>
              )}
            </div>
          </div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>setShowHealth(true)} style={{display:"flex",alignItems:"center",gap:5,padding:"7px 14px",borderRadius:10,border:"1px solid #e2e8f0",background:"#fff",color:"#64748b",cursor:"pointer",fontSize:12,fontWeight:500}}>
              <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>
              Status
            </button>
            <button onClick={()=>setShowAlerts(true)} style={{display:"flex",alignItems:"center",gap:5,padding:"7px 14px",borderRadius:10,border:"1px solid #e2e8f0",background:"#fff",color:"#64748b",cursor:"pointer",fontSize:12,fontWeight:500,position:"relative"}}><svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/></svg>Alerts{alerts.length>0&&<span style={{position:"absolute",top:-4,right:-4,width:18,height:18,borderRadius:9,background:"#dc2626",color:"#fff",fontSize:10,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center"}}>{alerts.length}</span>}</button>
            <button onClick={fetchData} style={{display:"flex",alignItems:"center",gap:5,padding:"7px 14px",borderRadius:10,border:"1px solid #e2e8f0",background:"#fff",color:"#64748b",cursor:"pointer",fontSize:12,fontWeight:500}}><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>Refresh</button>
          </div>
        </div>
        {stats&&<div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(150px, 1fr))",gap:10,marginBottom:18}}><StatCard label="Scanned" value={stats.total}/><StatCard label="Avg Safety" value={stats.avgScore} color={getScoreColor(stats.avgScore)}/><StatCard label="Rug Rate" value={stats.rugRate+"%"} color={stats.rugRate>30?"#dc2626":"#d97706"}/><StatCard label="Staircases" value={stats.stairs} color="#dc2626"/><StatCard label="Best Safety" value={stats.bestSafety?stats.bestSafety.symbol+" ("+stats.bestSafety.score+")":"—"} color="#16a34a"/></div>}
        <div style={{display:"flex",gap:10,marginBottom:14,flexWrap:"wrap",alignItems:"center"}}>
          <div style={{position:"relative",flex:1,maxWidth:300}}><svg width="16" height="16" fill="none" stroke="#94a3b8" viewBox="0 0 24 24" style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)"}}><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg><input type="text" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search..." style={{width:"100%",padding:"8px 12px 8px 38px",borderRadius:10,border:"1px solid #e2e8f0",background:"#fff",fontSize:13,color:"#1e293b",outline:"none"}}/></div>
          <div style={{display:"flex",gap:4}}><span style={{fontSize:11,color:"#94a3b8",alignSelf:"center",marginRight:4}}>Min</span>{[0,25,50,75].map(s=>(<button key={s} onClick={()=>setMinScore(s)} style={{padding:"5px 12px",borderRadius:8,border:"1px solid "+(minScore===s?"#2563eb":"#e2e8f0"),background:minScore===s?"#eff6ff":"#fff",color:minScore===s?"#2563eb":"#64748b",cursor:"pointer",fontSize:11,fontWeight:500}}>{s===0?"All":s+"+"}</button>))}</div>
        </div>
        {loading&&<div style={{display:"flex",flexDirection:"column",alignItems:"center",padding:80}}><div style={{width:28,height:28,border:"3px solid #e2e8f0",borderTopColor:"#2563eb",borderRadius:"50%",animation:"spin 1s linear infinite",marginBottom:14}}/><div style={{fontSize:13,color:"#94a3b8"}}>{!backendAwake?"Waking up Render backend (can take 30-50s)...":"Scanning Solana..."}</div></div>}
        {!loading&&<div style={{background:"#fff",borderRadius:12,border:"1px solid #e2e8f0",overflow:"hidden"}}><div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}><thead><tr style={{borderBottom:"1px solid #e2e8f0",background:"#f8fafc"}}><th style={{width:34,padding:"10px 6px"}}></th><SortTh col="safety" label="Safe" w={80}/><SortTh col="potential" label="x2" w={80}/><th style={{textAlign:"left",padding:"10px 8px",fontSize:10,fontWeight:600,color:"#94a3b8",width:120,textTransform:"uppercase",letterSpacing:0.5}}>Token</th><th style={{width:115,padding:"10px 8px"}}>Chart</th><SortTh col="price" label="Price" w={85}/><SortTh col="change_24h" label="24H" w={60}/><SortTh col="market_cap" label="MCap" w={70}/><SortTh col="volume_24h" label="Vol" w={70}/><SortTh col="liquidity" label="Liq" w={60}/><th style={{width:90,padding:"10px 8px"}}>Flags</th><th style={{width:30}}></th></tr></thead><tbody>
        {filtered.map(tk=>{const isW=watchlist.includes(tk.address);return(<tr key={tk.address||tk.id} onClick={()=>setSelected(tk)} style={{borderBottom:"1px solid #f1f5f9",cursor:"pointer",background:isW?"#fffbeb":"#fff"}} onMouseEnter={e=>e.currentTarget.style.background=isW?"#fef3c7":"#f8fafc"} onMouseLeave={e=>e.currentTarget.style.background=isW?"#fffbeb":"#fff"}>
          <td style={{padding:"8px 6px",textAlign:"center"}}><span onClick={e=>toggleWatch(tk.address,e)} style={{cursor:"pointer",color:isW?"#d97706":"#e2e8f0"}}>{isW?"★":"☆"}</span></td>
          <td style={{padding:"8px"}}><ScoreBadge score={tk.safety} type="safety"/></td>
          <td style={{padding:"8px"}}><ScoreBadge score={tk.potential} type="potential"/></td>
          <td style={{padding:"8px"}}><div style={{fontWeight:600,color:"#1e293b",fontSize:12}}>{tk.symbol}</div><div style={{fontSize:9,color:"#94a3b8"}}>{tk.address?.slice(0,8)}...</div></td>
          <td style={{padding:"8px"}}><MiniChart data={tk.price_history} bad={tk.staircase_detected}/></td>
          <td style={{padding:"8px",color:"#475569"}}>${fmtP(tk.price)}</td>
          <td style={{padding:"8px",fontWeight:600,color:tk.change_24h>=0?"#16a34a":"#dc2626"}}>{tk.change_24h>=0?"+":""}{(tk.change_24h||0).toFixed(1)}%</td>
          <td style={{padding:"8px",color:"#64748b"}}>${fmt(tk.market_cap)}</td>
          <td style={{padding:"8px",color:"#64748b"}}>${fmt(tk.volume_24h)}</td>
          <td style={{padding:"8px",color:tk.liquidity<5000?"#ea580c":"#64748b"}}>${fmt(tk.liquidity)}</td>
          <td style={{padding:"8px"}}><div style={{display:"flex",gap:3,flexWrap:"wrap"}}>{tk.honeypot_detected&&<FlagBadge label="Honeypot" type="danger"/>}{tk.sell_tax>15&&<FlagBadge label={"Tax "+tk.sell_tax.toFixed(0)+"%"} type="danger"/>}{tk.sell_tax>5&&tk.sell_tax<=15&&<FlagBadge label={"Tax "+tk.sell_tax.toFixed(0)+"%"} type="warn"/>}{tk.staircase_detected&&<FlagBadge label="Stairs" type="danger"/>}{tk.rugcheck?.mintEnabled&&<FlagBadge label="Mint" type="danger"/>}{tk.rugcheck?.freezeEnabled&&<FlagBadge label="Freeze" type="warn"/>}{tk.buy_slippage>10&&<FlagBadge label={"Slip "+tk.buy_slippage.toFixed(0)+"%"} type="warn"/>}{tk.safety>=70&&!tk.staircase_detected&&!tk.honeypot_detected&&!(tk.sell_tax>5)&&<FlagBadge label="Clean" type="ok"/>}</div></td>
          <td style={{padding:"8px 6px",textAlign:"center"}}><span onClick={e=>copyAddr(tk.address,e)} style={{cursor:"pointer",fontSize:12,color:copied===tk.address?"#16a34a":"#cbd5e1"}}>{copied===tk.address?"✓":"⊕"}</span></td>
        </tr>);})}
        </tbody></table></div>{filtered.length===0&&<div style={{textAlign:"center",padding:50,color:"#94a3b8",fontSize:13}}>{tab==="watchlist"?"No tokens in watchlist":tokens.length===0?"Waiting for first scan...":"No tokens match filters"}</div>}</div>}
      </main>
      {selected&&<TokenDetail token={selected} onClose={()=>setSelected(null)}/>}
      {showAlerts&&<AlertsPanel alerts={alerts} onClose={()=>setShowAlerts(false)}/>}
      {showHealth&&<HealthPanel health={health} onClose={()=>setShowHealth(false)}/>}
    </div>
  );
}
