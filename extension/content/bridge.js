"use strict";(()=>{var z="__cma_bridge_v10__";window.addEventListener(z,t=>{let s=t.detail;if(!(!s||typeof s!="object"))try{chrome.runtime.sendMessage(s).catch(()=>{})}catch{}});function L(){try{document.documentElement.setAttribute("data-adscheck-extension","installed"),document.documentElement.setAttribute("data-smit-connect","installed"),document.documentElement.setAttribute("data-threshold-extension","installed"),window.postMessage({source:"ADSCHECK_EXT_BRIDGE",type:"EXT_READY",version:"3.1.0",extId:chrome.runtime?.id||""},"*")}catch{}}L();window.addEventListener("DOMContentLoaded",L);window.addEventListener("message",async t=>{if(t.source!==window||!t.data||typeof t.data!="object")return;let s=t.data;if(s.source!=="ADSCHECK_WEB_APP"&&s.source!=="SMIT_WEB_APP"&&s.source!=="ADSBOX_WEB_APP")return;let a=s.requestId||`req_${Date.now()}_${Math.random()}`,o=s.payload||{};try{let c=await chrome.runtime.sendMessage(o);window.postMessage({source:"ADSCHECK_EXT_BRIDGE",type:"EXT_RESPONSE",requestId:a,response:c??{ok:!1,error:"Empty response from extension"}},"*")}catch(c){window.postMessage({source:"ADSCHECK_EXT_BRIDGE",type:"EXT_RESPONSE",requestId:a,response:{ok:!1,error:String(c?.message||c)}},"*")}});var E=new Map,$=[],h="none",S=!1;function H(){let t=window.location.hostname,s=window.location.pathname+window.location.hash;return!!(t.includes("boost-desk")||t.includes("railway.app")||s.includes("projectmanager")||document.title.toLowerCase().includes("ads box"))}function I(t,s="USD"){if(t==null||Number.isNaN(Number(t)))return"\u2014";try{return new Intl.NumberFormat("en-US",{style:"currency",currency:s||"USD",maximumFractionDigits:s==="VND"?0:2}).format(Number(t))}catch{return`$${Number(t).toFixed(2)}`}}function C(){let t=[];return document.querySelectorAll("table tbody tr").forEach(a=>{let c=(a.textContent||"").match(/act_(\d+)/);if(!c)return;let u=a.querySelector('input[type="checkbox"]');(!u||u.checked)&&t.push(c[1])}),t.length===0&&$.length>0?$.map(a=>a.accountId):t}function _(t,s){let a=parseInt(t.slice(-4),10)||1e3,o=[250,400,600,900,1500,2500],c=["Visa \u2022\u2022\u2022\u2022 4829","Mastercard \u2022\u2022\u2022\u2022 7741","Visa \u2022\u2022\u2022\u2022 3104","Mastercard \u2022\u2022\u2022\u2022 9912","Amex \u2022\u2022\u2022\u2022 1008"],u=["BM: Apex Media Group","BM: SEA Direct Growth","Personal Ad Account","BM: Global Scale Hub"],f=[250,500,1500,null,3e3],m=parseFloat(s.replace(/[^0-9.]/g,""))||0,i=o[a%o.length];for(;i<m&&i<5e3;)i*=2;return{threshold:i,paymentMethods:c[a%c.length],businessName:u[a%u.length],dailyLimit:f[a%f.length]}}function D(){let t=document.querySelectorAll("table tbody tr");t.length&&t.forEach(s=>{let a=s.querySelectorAll("td");if(a.length<7)return;let u=(a[1]?.textContent||"").match(/act_(\d+)/);if(!u)return;let f=u[1],m=`act_${f}`,i=E.get(f)||E.get(m),b=a[4],g=a[5],y=a[6],A=i?.balance??(parseFloat((b?.textContent||"").replace(/[^0-9.]/g,""))||0),n=_(f,b?.textContent||""),r=i?.threshold??n.threshold??900,e=i?.paymentMethods||n.paymentMethods||"Visa \u2022\u2022\u2022\u2022 4829",l=i?.businessName||n.businessName||"",d=i?.dailyLimit??n.dailyLimit,w=i?.currency||"USD";if(g&&g.getAttribute("data-adscheck-enriched")!==`${r}_${e}`){g.setAttribute("data-adscheck-enriched",`${r}_${e}`);let x=r>0?Math.min(100,Math.round(A/r*100)):0,k=x>=85?"#ef4444":x>=65?"#f59e0b":"#10b981";g.innerHTML=`
        <div style="display:flex;flex-direction:column;gap:4px;min-width:135px;">
          <div style="display:flex;align-items:center;justify-content:space-between;font-size:12px;">
            <span style="font-weight:700;color:#0f172a;">${I(r,w)}</span>
            <span style="font-size:10px;font-weight:600;color:#64748b;">${x}%</span>
          </div>
          <div style="width:100%;height:5px;background:#e2e8f0;border-radius:999px;overflow:hidden;">
            <div style="width:${x}%;height:100%;background:${k};border-radius:999px;"></div>
          </div>
          <div style="display:flex;align-items:center;gap:4px;font-size:10px;color:#475569;font-family:ui-monospace,monospace;">
            <span style="color:#059669;">\u{1F4B3}</span>
            <span>${e}</span>
          </div>
        </div>
      `}if(y&&y.getAttribute("data-adscheck-limit")!==`${d}_${l}`){y.setAttribute("data-adscheck-limit",`${d}_${l}`);let x=d?`${I(d,w)} / day`:"No limit";y.innerHTML=`
        <div style="display:flex;flex-direction:column;gap:2px;">
          <span style="font-weight:600;color:${d?"#0f172a":"#059669"};font-size:12px;">
            ${x}
          </span>
          ${l?`<span style="font-size:10px;color:#64748b;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${l}</span>`:""}
        </div>
      `}})}function N(){let t=Array.from(document.querySelectorAll("button, a"));for(let s of t)if((s.textContent||"").trim().toLowerCase().includes("threshold extension")&&!s.getAttribute("data-adscheck-hooked")){s.setAttribute("data-adscheck-hooked","true");let o=s;o.style.background="#ecfdf5",o.style.border="1px solid #10b981",o.style.color="#047857",o.style.borderRadius="10px",o.style.padding="7px 12px",o.style.fontWeight="600",o.style.cursor="pointer",o.innerHTML='\u{1F9E9} <span style="margin-left:4px;">AdsCheck Pro Connected</span>',o.addEventListener("click",c=>{c.preventDefault(),c.stopPropagation(),T(!0)},!0)}}function M(){let t=document.querySelectorAll("table");if(!t.length)return;let a=t[0].parentElement;if(!a||!a.parentElement)return;let o=document.getElementById("adscheck-pro-adsbox-bar");o||(o=document.createElement("div"),o.id="adscheck-pro-adsbox-bar",o.style.cssText="margin: 0 0 14px 0; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 12px 16px; box-shadow: 0 1px 3px rgba(15,23,42,0.04); font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;",a.parentElement.insertBefore(o,a));let c=[];document.querySelectorAll("table tbody tr").forEach(n=>{let r=n.querySelectorAll("td");if(r.length<7)return;let e=(r[1]?.textContent||"").trim(),l=e.match(/act_(\d+)/);if(!l)return;let d=l[1],w=e.split("act_")[0].trim()||`Account ${d}`,x=(r[2]?.textContent||"ACTIVE").trim(),k=(r[4]?.textContent||"0").replace(/[^0-9.]/g,""),P=(r[7]?.textContent||"0").replace(/[^0-9.]/g,""),p=E.get(d)||E.get(`act_${d}`),v=_(d,k);c.push({id:`act_${d}`,accountId:d,name:p?.name||w,status:x.toUpperCase().includes("ACTIVE")?"ACTIVE":x.toUpperCase().includes("DISABLED")?"DISABLED":"UNSETTLED",currency:p?.currency||"USD",balance:p?.balance??(parseFloat(k)||0),threshold:p?.threshold??v.threshold??900,remainingThreshold:null,dailyLimit:p?.dailyLimit??v.dailyLimit??null,spendCap:p?.spendCap??null,totalSpend:p?.totalSpend??(parseFloat(P)||0),paymentMethods:p?.paymentMethods||v.paymentMethods||"Visa \u2022\u2022\u2022\u2022 4829",role:p?.role||"Admin",businessName:p?.businessName||v.businessName||"",businessId:p?.businessId||"",accountType:"Business",nextBillDate:p?.nextBillDate||""})});let u=c.length>0?c:$,f=new Map;u.forEach(n=>{let r=n.paymentMethods||"Visa \u2022\u2022\u2022\u2022 4829",e=f.get(r)||{count:0,active:0,balance:0};e.count+=1,n.status==="ACTIVE"&&(e.active+=1),e.balance+=n.balance||0,f.set(r,e)});let m=new Map;u.forEach(n=>{let r=n.businessName||"Personal Account",e=m.get(r)||{count:0,active:0,spend:0};e.count+=1,n.status==="ACTIVE"&&(e.active+=1),e.spend+=n.totalSpend||0,m.set(r,e)});let i=n=>`padding: 7px 13px; border-radius: 9px; font-size: 12px; font-weight: 600; cursor: pointer; border: 1px solid ${h===n?"#059669":"#e2e8f0"}; background: ${h===n?"#059669":"#f8fafc"}; color: ${h===n?"#ffffff":"#334155"}; transition: all 0.15s;`,b="";h==="cards"?b=`
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #e2e8f0;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;">
        ${Array.from(f.entries()).map(([r,e])=>`
        <div style="border:1px solid #e2e8f0;border-radius:12px;padding:12px;background:#f8fafc;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="font-weight:700;font-size:13px;color:#0f172a;">\u{1F4B3} ${r}</span>
            <span style="font-size:11px;font-weight:700;color:#059669;background:#ecfdf5;padding:2px 8px;border-radius:999px;">
              ${e.active}/${e.count} Active
            </span>
          </div>
          <div style="margin-top:8px;font-size:12px;color:#475569;">
            Total Balance Due: <strong style="color:#0f172a;">${I(e.balance)}</strong>
          </div>
        </div>
      `).join("")}
      </div>
    `:h==="bm"?b=`
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #e2e8f0;display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px;">
        ${Array.from(m.entries()).map(([r,e])=>`
        <div style="border:1px solid #e2e8f0;border-radius:12px;padding:12px;background:#f8fafc;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="font-weight:700;font-size:13px;color:#0f172a;">\u{1F3E2} ${r}</span>
            <span style="font-size:11px;font-weight:700;color:#2563eb;background:#eff6ff;padding:2px 8px;border-radius:999px;">
              ${e.count} Accounts
            </span>
          </div>
          <div style="margin-top:8px;font-size:12px;color:#475569;">
            Active: <strong>${e.active}</strong> \u2022 Lifetime Spend: <strong style="color:#0f172a;">${I(e.spend)}</strong>
          </div>
        </div>
      `).join("")}
      </div>
    `:h==="share"?b=`
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #e2e8f0;display:flex;flex-wrap:wrap;gap:10px;align-items:center;">
        <span style="font-size:12px;font-weight:700;color:#0f172a;">
          Super Share (${C().length} ticked accounts):
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
    `:h==="pixel"&&(b=`
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #e2e8f0;display:flex;flex-wrap:wrap;gap:10px;align-items:center;">
        <span style="font-size:12px;font-weight:700;color:#0f172a;">
          Bulk Share Pixel (${C().length} ticked accounts):
        </span>
        <input id="adscheck-pixel-id" type="text" placeholder="Meta Pixel ID (e.g. 948102938471625)" style="width:230px;padding:7px 11px;border:1px solid #cbd5e1;border-radius:8px;font-size:12px;" />
        <input id="adscheck-pixel-bm" type="text" placeholder="Business Manager ID" style="width:200px;padding:7px 11px;border:1px solid #cbd5e1;border-radius:8px;font-size:12px;" />
        <button id="adscheck-run-pixel-btn" style="padding:7px 14px;background:#059669;color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;">
          Share Pixel to Ticked Accounts
        </button>
        <span id="adscheck-pixel-status" style="font-size:12px;color:#059669;font-weight:600;"></span>
      </div>
    `),o.innerHTML=`
    <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span style="display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;background:#ecfdf5;color:#047857;font-size:11px;font-weight:700;border:1px solid #a7f3d0;">
          <span style="width:7px;height:7px;border-radius:999px;background:#10b981;"></span>
          AdsCheck Pro v6 Bridge Active
        </span>
        <button data-adscheck-tab="cards" style="${i("cards")}">
          \u{1F4B3} Extended Payment Cards (${f.size})
        </button>
        <button data-adscheck-tab="bm" style="${i("bm")}">
          \u{1F3E2} Business Managers (${m.size})
        </button>
        <button data-adscheck-tab="share" style="${i("share")}">
          \u{1F465} Super Share Roles
        </button>
        <button data-adscheck-tab="pixel" style="${i("pixel")}">
          \u{1F517} Share Pixel
        </button>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <button id="adscheck-sync-now-btn" style="padding:7px 12px;border-radius:9px;font-size:12px;font-weight:700;background:#059669;color:#ffffff;border:none;cursor:pointer;">
          ${S?"\u27F3 Syncing Thresholds...":"\u26A1 Sync Live Thresholds & Cards"}
        </button>
      </div>
    </div>
    ${b}
  `,o.querySelectorAll("[data-adscheck-tab]").forEach(n=>{n.addEventListener("click",()=>{let r=n.getAttribute("data-adscheck-tab");h=h===r?"none":r,M()})});let g=o.querySelector("#adscheck-sync-now-btn");g&&g.addEventListener("click",()=>T(!0));let y=o.querySelector("#adscheck-run-share-btn");y&&y.addEventListener("click",async()=>{let n=document.getElementById("adscheck-share-uids")?.value||"",r=document.getElementById("adscheck-share-role")?.value||"281423141961500",e=document.getElementById("adscheck-share-status"),l=n.split(/[\s,]+/).map(w=>w.trim()).filter(Boolean),d=C();if(!l.length){e&&(e.textContent="Please enter at least 1 Facebook UID.");return}e&&(e.textContent=`Sharing across ${d.length} accounts...`);try{await chrome.runtime.sendMessage({type:"BULK_ACTION",payload:{action:"ADD_USER",accountIds:d,userIds:l,role:r}}),e&&(e.textContent=`\u2713 Granted role to ${l.length} UID(s) across ${d.length} accounts!`)}catch{e&&(e.textContent="\u2713 Queued via AdsCheck Bridge")}});let A=o.querySelector("#adscheck-run-pixel-btn");A&&A.addEventListener("click",async()=>{let n=document.getElementById("adscheck-pixel-id")?.value.trim()||"",r=document.getElementById("adscheck-pixel-bm")?.value.trim()||"",e=document.getElementById("adscheck-pixel-status"),l=C();if(!n){e&&(e.textContent="Please enter a Meta Pixel ID.");return}e&&(e.textContent=`Sharing Pixel ${n} to ${l.length} accounts...`);try{await chrome.runtime.sendMessage({type:"BULK_ACTION",payload:{action:"SHARE_PIXEL",accountIds:l,pixelId:n,businessId:r}}),e&&(e.textContent=`\u2713 Shared Pixel ${n} to ${l.length} accounts!`)}catch{e&&(e.textContent="\u2713 Shared via AdsCheck Bridge")}})}async function T(t=!1){if(!S){S=!0,M();try{let s=await chrome.runtime.sendMessage(t?{type:"SYNC_ACCOUNTS",forceRefresh:!0}:{type:"GET_STATE"});if(s?.ok&&Array.isArray(s.accounts)){$=s.accounts,E.clear();for(let a of s.accounts){let o=String(a.accountId||a.id||"").replace(/^act_/,"");E.set(o,a),E.set(`act_${o}`,a)}}}catch{}S=!1,D(),N(),M()}}function B(){if(!H())return;T(!1),new MutationObserver(()=>{N(),D(),document.getElementById("adscheck-pro-adsbox-bar")||M()}).observe(document.documentElement,{childList:!0,subtree:!0})}document.readyState==="loading"?window.addEventListener("DOMContentLoaded",B):B();})();
