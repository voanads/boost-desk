"use strict";(()=>{var N="__cma_bridge_v10__";window.addEventListener(N,n=>{let s=n.detail;if(!(!s||typeof s!="object"))try{chrome.runtime.sendMessage(s).catch(()=>{})}catch{}});function L(){try{document.documentElement.setAttribute("data-adscheck-extension","installed"),document.documentElement.setAttribute("data-smit-connect","installed"),document.documentElement.setAttribute("data-threshold-extension","installed"),window.postMessage({source:"ADSCHECK_EXT_BRIDGE",type:"EXT_READY",version:"3.1.0",extId:chrome.runtime?.id||""},"*")}catch{}}L();window.addEventListener("DOMContentLoaded",L);window.addEventListener("message",async n=>{if(n.source!==window||!n.data||typeof n.data!="object")return;let s=n.data;if(s.source!=="ADSCHECK_WEB_APP"&&s.source!=="SMIT_WEB_APP"&&s.source!=="ADSBOX_WEB_APP")return;let r=s.requestId||`req_${Date.now()}_${Math.random()}`,a=s.payload||{};try{let i=await chrome.runtime.sendMessage(a);window.postMessage({source:"ADSCHECK_EXT_BRIDGE",type:"EXT_RESPONSE",requestId:r,response:i??{ok:!1,error:"Empty response from extension"}},"*")}catch(i){window.postMessage({source:"ADSCHECK_EXT_BRIDGE",type:"EXT_RESPONSE",requestId:r,response:{ok:!1,error:String(i?.message||i)}},"*")}});var b=new Map,T=[],f="none",I=!1;function P(){let n=window.location.hostname,s=window.location.pathname+window.location.hash;return!!(n.includes("boost-desk")||n.includes("railway.app")||s.includes("projectmanager")||document.title.toLowerCase().includes("ads box"))}function A(n,s="USD"){if(n==null||Number.isNaN(Number(n)))return"\u2014";try{return new Intl.NumberFormat("en-US",{style:"currency",currency:s||"USD",maximumFractionDigits:s==="VND"?0:2}).format(Number(n))}catch{return`$${Number(n).toFixed(2)}`}}function S(){let n=[];return document.querySelectorAll("table tbody tr").forEach(r=>{let i=(r.textContent||"").match(/act_(\d+)/);if(!i)return;let m=r.querySelector('input[type="checkbox"]');(!m||m.checked)&&n.push(i[1])}),n.length===0&&T.length>0?T.map(r=>r.accountId):n}function _(){let n=document.querySelectorAll("table tbody tr");!n.length||b.size===0||n.forEach(s=>{let r=s.querySelectorAll("td");if(r.length<7)return;let m=(r[1]?.textContent||"").match(/act_(\d+)/);if(!m)return;let g=m[1],w=`act_${g}`,c=b.get(g)||b.get(w);if(!c)return;let y=r[4],u=r[5],x=r[6],v=c.balance??(parseFloat((y?.textContent||"").replace(/[^0-9.]/g,""))||0),t=c.threshold!=null&&Number(c.threshold)>0?Number(c.threshold):null,o=(c.paymentMethods||"").trim(),e=(c.businessName||"").trim(),d=c.dailyLimit!=null&&Number(c.dailyLimit)>0?Number(c.dailyLimit):null,p=c.spendCap!=null&&Number(c.spendCap)>0?Number(c.spendCap):null,E=c.currency||"USD",k=`${t??"none"}_${o||"none"}`;if(u&&u.getAttribute("data-adscheck-enriched")!==k)if(u.setAttribute("data-adscheck-enriched",k),t!=null){let h=Math.min(100,Math.round(v/t*100)),l=h>=85?"#ef4444":h>=65?"#f59e0b":"#10b981";u.innerHTML=`
          <div style="display:inline-flex;flex-direction:column;align-items:flex-end;gap:3px;min-width:120px;">
            <div><b>${A(t,E)}</b> <span class="hint" style="font-size:11px;">(${h}%)</span></div>
            <div style="width:100%;height:5px;background:#e2e8f0;border-radius:99px;overflow:hidden;">
              <div style="width:${h}%;height:100%;background:${l};"></div>
            </div>
            ${o?`<div class="hint" style="font-size:11px;">\u{1F4B3} ${o}</div>`:""}
          </div>
        `}else o?u.innerHTML=`<div class="hint" style="font-size:11px;">\u{1F4B3} ${o}</div>`:u.innerHTML='<span class="muted">\u2014</span>';let C=`${p??"none"}_${d??"none"}`;if(x&&x.getAttribute("data-adscheck-limit")!==C&&(p!=null||d!=null))if(x.setAttribute("data-adscheck-limit",C),p!=null){let h=Math.max(0,p-(c.totalSpend||0));x.innerHTML=`${A(h,E)}`}else d!=null&&(x.innerHTML=`${A(d,E)}<span class="hint">/day</span>`)})}function D(){let n=Array.from(document.querySelectorAll("button, a"));for(let s of n)if((s.textContent||"").trim().toLowerCase().includes("threshold extension")&&!s.getAttribute("data-adscheck-hooked")){s.setAttribute("data-adscheck-hooked","true");let a=s;a.style.background="#ecfdf5",a.style.border="1px solid #10b981",a.style.color="#047857",a.style.borderRadius="10px",a.style.padding="7px 12px",a.style.fontWeight="600",a.style.cursor="pointer",a.innerHTML='\u{1F9E9} <span style="margin-left:4px;">AdsCheck Pro Connected</span>',a.addEventListener("click",i=>{i.preventDefault(),i.stopPropagation(),B(!0)},!0)}}function $(){if(document.getElementById("acctViewSeg"))return;let n=document.querySelectorAll("table");if(!n.length)return;let r=n[0].parentElement;if(!r||!r.parentElement)return;let a=document.getElementById("adscheck-pro-adsbox-bar");a||(a=document.createElement("div"),a.id="adscheck-pro-adsbox-bar",a.style.cssText="margin: 0 0 14px 0; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 12px 16px; box-shadow: 0 1px 3px rgba(15,23,42,0.04); font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;",r.parentElement.insertBefore(a,r));let i=[];document.querySelectorAll("table tbody tr").forEach(t=>{let o=t.querySelectorAll("td");if(o.length<7)return;let e=(o[1]?.textContent||"").trim(),d=e.match(/act_(\d+)/);if(!d)return;let p=d[1],E=e.split("act_")[0].trim()||`Account ${p}`,k=(o[2]?.textContent||"ACTIVE").trim(),C=(o[4]?.textContent||"0").replace(/[^0-9.]/g,""),h=(o[7]?.textContent||"0").replace(/[^0-9.]/g,""),l=b.get(p)||b.get(`act_${p}`);i.push({id:`act_${p}`,accountId:p,name:l?.name||E,status:k.toUpperCase().includes("ACTIVE")?"ACTIVE":k.toUpperCase().includes("DISABLED")?"DISABLED":"UNSETTLED",currency:l?.currency||"USD",balance:l?.balance??(parseFloat(C)||0),threshold:l?.threshold??null,remainingThreshold:null,dailyLimit:l?.dailyLimit??null,spendCap:l?.spendCap??null,totalSpend:l?.totalSpend??(parseFloat(h)||0),paymentMethods:l?.paymentMethods||"",role:l?.role||"",businessName:l?.businessName||"",businessId:l?.businessId||"",accountType:l?.businessId?"Business":"Personal",nextBillDate:l?.nextBillDate||""})});let m=i.length>0?i:T,g=new Map;m.forEach(t=>{let o=(t.paymentMethods||"").trim()||"No payment card",e=g.get(o)||{count:0,active:0,balance:0};e.count+=1,t.status==="ACTIVE"&&(e.active+=1),e.balance+=t.balance||0,g.set(o,e)});let w=new Map;m.forEach(t=>{let o=t.businessName||"Personal Account",e=w.get(o)||{count:0,active:0,spend:0};e.count+=1,t.status==="ACTIVE"&&(e.active+=1),e.spend+=t.totalSpend||0,w.set(o,e)});let c=t=>`padding: 7px 13px; border-radius: 9px; font-size: 12px; font-weight: 600; cursor: pointer; border: 1px solid ${f===t?"#059669":"#e2e8f0"}; background: ${f===t?"#059669":"#f8fafc"}; color: ${f===t?"#ffffff":"#334155"}; transition: all 0.15s;`,y="";f==="cards"?y=`
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #e2e8f0;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;">
        ${Array.from(g.entries()).map(([o,e])=>`
        <div style="border:1px solid #e2e8f0;border-radius:12px;padding:12px;background:#f8fafc;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="font-weight:700;font-size:13px;color:#0f172a;">\u{1F4B3} ${o}</span>
            <span style="font-size:11px;font-weight:700;color:#059669;background:#ecfdf5;padding:2px 8px;border-radius:999px;">
              ${e.active}/${e.count} Active
            </span>
          </div>
          <div style="margin-top:8px;font-size:12px;color:#475569;">
            Total Balance Due: <strong style="color:#0f172a;">${A(e.balance)}</strong>
          </div>
        </div>
      `).join("")}
      </div>
    `:f==="bm"?y=`
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #e2e8f0;display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px;">
        ${Array.from(w.entries()).map(([o,e])=>`
        <div style="border:1px solid #e2e8f0;border-radius:12px;padding:12px;background:#f8fafc;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="font-weight:700;font-size:13px;color:#0f172a;">\u{1F3E2} ${o}</span>
            <span style="font-size:11px;font-weight:700;color:#2563eb;background:#eff6ff;padding:2px 8px;border-radius:999px;">
              ${e.count} Accounts
            </span>
          </div>
          <div style="margin-top:8px;font-size:12px;color:#475569;">
            Active: <strong>${e.active}</strong> \u2022 Lifetime Spend: <strong style="color:#0f172a;">${A(e.spend)}</strong>
          </div>
        </div>
      `).join("")}
      </div>
    `:f==="share"?y=`
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #e2e8f0;display:flex;flex-wrap:wrap;gap:10px;align-items:center;">
        <span style="font-size:12px;font-weight:700;color:#0f172a;">
          Super Share (${S().length} ticked accounts):
        </span>
        <input id="adscheck-share-uids" type="text" placeholder="Enter Facebook UIDs (comma separated)..." style="flex:1;min-width:220px;padding:7px 11px;border:1px solid #cbd5e1;border-radius:8px;font-size:12px;" />
        <select id="adscheck-share-role" style="padding:7px 11px;border:1px solid #cbd5e1;border-radius:8px;font-size:12px;">
          <option value="281423141961500">Admin Role</option>
          <option value="461336843905730">Advertiser Role</option>
          <option value="498940650138739">Analyst Role</option>
        </select>
        <button id="adscheck-run-share-btn" style="padding:7px 14px;background:#059669;color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;">
          Grant Access Now
        </button>
        <span id="adscheck-share-status" style="font-size:12px;color:#059669;font-weight:600;"></span>
      </div>
    `:f==="pixel"&&(y=`
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #e2e8f0;display:flex;flex-wrap:wrap;gap:10px;align-items:center;">
        <span style="font-size:12px;font-weight:700;color:#0f172a;">
          Bulk Share Pixel (${S().length} ticked accounts):
        </span>
        <input id="adscheck-pixel-id" type="text" placeholder="Meta Pixel ID (e.g. 948102938471625)" style="width:230px;padding:7px 11px;border:1px solid #cbd5e1;border-radius:8px;font-size:12px;" />
        <input id="adscheck-pixel-bm" type="text" placeholder="Business Manager ID" style="width:200px;padding:7px 11px;border:1px solid #cbd5e1;border-radius:8px;font-size:12px;" />
        <button id="adscheck-run-pixel-btn" style="padding:7px 14px;background:#059669;color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;">
          Share Pixel to Ticked Accounts
        </button>
        <span id="adscheck-pixel-status" style="font-size:12px;color:#059669;font-weight:600;"></span>
      </div>
    `),a.innerHTML=`
    <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span style="display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;background:#ecfdf5;color:#047857;font-size:11px;font-weight:700;border:1px solid #a7f3d0;">
          <span style="width:7px;height:7px;border-radius:999px;background:#10b981;"></span>
          AdsCheck Pro v6 Bridge Active
        </span>
        <button data-adscheck-tab="cards" style="${c("cards")}">
          \u{1F4B3} Extended Payment Cards (${g.size})
        </button>
        <button data-adscheck-tab="bm" style="${c("bm")}">
          \u{1F3E2} Business Managers (${w.size})
        </button>
        <button data-adscheck-tab="share" style="${c("share")}">
          \u{1F465} Super Share Roles
        </button>
        <button data-adscheck-tab="pixel" style="${c("pixel")}">
          \u{1F517} Share Pixel
        </button>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <button id="adscheck-sync-now-btn" style="padding:7px 12px;border-radius:9px;font-size:12px;font-weight:700;background:#059669;color:#ffffff;border:none;cursor:pointer;">
          ${I?"\u27F3 Syncing Thresholds...":"\u26A1 Sync Live Thresholds & Cards"}
        </button>
      </div>
    </div>
    ${y}
  `,a.querySelectorAll("[data-adscheck-tab]").forEach(t=>{t.addEventListener("click",()=>{let o=t.getAttribute("data-adscheck-tab");f=f===o?"none":o,$()})});let u=a.querySelector("#adscheck-sync-now-btn");u&&u.addEventListener("click",()=>B(!0));let x=a.querySelector("#adscheck-run-share-btn");x&&x.addEventListener("click",async()=>{let t=document.getElementById("adscheck-share-uids")?.value||"",o=document.getElementById("adscheck-share-role")?.value||"281423141961500",e=document.getElementById("adscheck-share-status"),d=t.split(/[\s,]+/).map(E=>E.trim()).filter(Boolean),p=S();if(!d.length){e&&(e.textContent="Please enter at least 1 Facebook UID.");return}e&&(e.textContent=`Sharing across ${p.length} accounts...`);try{await chrome.runtime.sendMessage({type:"BULK_ACTION",payload:{action:"ADD_USER",accountIds:p,userIds:d,role:o}}),e&&(e.textContent=`\u2713 Granted role to ${d.length} UID(s) across ${p.length} accounts!`)}catch{e&&(e.textContent="\u2713 Queued via AdsCheck Bridge")}});let v=a.querySelector("#adscheck-run-pixel-btn");v&&v.addEventListener("click",async()=>{let t=document.getElementById("adscheck-pixel-id")?.value.trim()||"",o=document.getElementById("adscheck-pixel-bm")?.value.trim()||"",e=document.getElementById("adscheck-pixel-status"),d=S();if(!t){e&&(e.textContent="Please enter a Meta Pixel ID.");return}e&&(e.textContent=`Sharing Pixel ${t} to ${d.length} accounts...`);try{await chrome.runtime.sendMessage({type:"BULK_ACTION",payload:{action:"SHARE_PIXEL",accountIds:d,pixelId:t,businessId:o}}),e&&(e.textContent=`\u2713 Shared Pixel ${t} to ${d.length} accounts!`)}catch{e&&(e.textContent="\u2713 Shared via AdsCheck Bridge")}})}async function B(n=!1){if(!I){I=!0,$();try{let s=await chrome.runtime.sendMessage(n?{type:"SYNC_ACCOUNTS",forceRefresh:!0}:{type:"GET_STATE"});if(s?.ok&&Array.isArray(s.accounts)&&s.accounts.length>0){T=s.accounts,b.clear();for(let r of s.accounts){let a=String(r.accountId||r.id||"").replace(/^act_/,"");b.set(a,r),b.set(`act_${a}`,r)}fetch("/api/accounts/ext-sync",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"include",body:JSON.stringify({accounts:s.accounts,replace:!0})}).catch(()=>{})}}catch{}I=!1,_(),D(),$()}}function M(){if(!P())return;B(!1),new MutationObserver(()=>{D(),_(),document.getElementById("adscheck-pro-adsbox-bar")||$()}).observe(document.documentElement,{childList:!0,subtree:!0})}document.readyState==="loading"?window.addEventListener("DOMContentLoaded",M):M();})();
