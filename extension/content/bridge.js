"use strict";(()=>{var R="__cma_bridge_v10__";window.addEventListener(R,n=>{let t=n.detail;if(!(!t||typeof t!="object"))try{chrome.runtime.sendMessage(t).catch(()=>{})}catch{}});function P(){try{document.documentElement.setAttribute("data-adscheck-extension","installed"),document.documentElement.setAttribute("data-smit-connect","installed"),document.documentElement.setAttribute("data-threshold-extension","installed"),window.postMessage({source:"ADSCHECK_EXT_BRIDGE",type:"EXT_READY",version:"3.1.0",extId:chrome.runtime?.id||""},"*")}catch{}}P();window.addEventListener("DOMContentLoaded",P);window.addEventListener("message",async n=>{if(n.source!==window||!n.data||typeof n.data!="object")return;let t=n.data;if(t.source!=="ADSCHECK_WEB_APP"&&t.source!=="SMIT_WEB_APP"&&t.source!=="ADSBOX_WEB_APP")return;let r=t.requestId||`req_${Date.now()}_${Math.random()}`,s=t.payload||{};try{let d=await chrome.runtime.sendMessage(s);window.postMessage({source:"ADSCHECK_EXT_BRIDGE",type:"EXT_RESPONSE",requestId:r,response:d??{ok:!1,error:"Empty response from extension"}},"*")}catch(d){window.postMessage({source:"ADSCHECK_EXT_BRIDGE",type:"EXT_RESPONSE",requestId:r,response:{ok:!1,error:String(d?.message||d)}},"*")}});var m=new Map,T=[],f="none",I=!1;function U(){let n=window.location.hostname,t=window.location.pathname+window.location.hash;return!!(n.includes("boost-desk")||n.includes("railway.app")||t.includes("projectmanager")||document.title.toLowerCase().includes("ads box"))}function _(n,t="USD"){if(n==null||Number.isNaN(Number(n)))return"\u2014";try{return new Intl.NumberFormat("en-US",{style:"currency",currency:t||"USD",maximumFractionDigits:t==="VND"?0:2}).format(Number(n))}catch{return`$${Number(n).toFixed(2)}`}}function v(){let n=[];return document.querySelectorAll("table tbody tr").forEach(r=>{let d=(r.textContent||"").match(/act_(\d+)/);if(!d)return;let y=r.querySelector('input[type="checkbox"]');(!y||y.checked)&&n.push(d[1])}),n.length===0&&T.length>0?T.map(r=>r.accountId):n}function A(n,t=!0){if(n==null||Number.isNaN(Number(n)))return t?"0":"-";let r=Math.round(Number(n)*100)/100;return r===0&&!t?"-":r.toLocaleString("en-US",{minimumFractionDigits:0,maximumFractionDigits:2})}function z(){let n=document.querySelectorAll("table tbody tr");!n.length||m.size===0||n.forEach(t=>{let r=t.getAttribute("data-smit-row");if(r){let c=m.get(r)||m.get(`act_${r}`);if(!c)return;let w=t.querySelector('[data-smit-cell="orig"]'),L=t.querySelector('[data-smit-cell="balance"]'),k=t.querySelector('[data-smit-cell="threshold"]'),i=t.querySelector('[data-smit-cell="remain"]'),$=t.querySelector('[data-smit-cell="limit"]');w&&c.businessId&&w.textContent==="-"&&(w.textContent=c.businessId);let q=c.balance??(parseFloat((L?.textContent||"").replace(/[^0-9.-]/g,""))||0),S=c.threshold!=null&&Number(c.threshold)>0?Number(c.threshold):null,M=c.dailyLimit!=null&&Number(c.dailyLimit)>0?Number(c.dailyLimit):c.spendCap!=null&&Number(c.spendCap)>0?Number(c.spendCap):null;k&&S!=null&&(k.textContent=A(S,!1)),i&&S!=null&&(i.textContent=A(Math.round(S-q),!0)),$&&M!=null&&($.textContent=A(M,!1));return}let s=t.querySelectorAll("td");if(s.length<7)return;let x=(s[1]?.textContent||"").match(/act_(\d+)/);if(!x)return;let h=x[1],E=`act_${h}`,l=m.get(h)||m.get(E);if(!l)return;let C=s[4],b=s[5],g=s[6],o=l.balance??(parseFloat((C?.textContent||"").replace(/[^0-9.]/g,""))||0),a=l.threshold!=null&&Number(l.threshold)>0?Number(l.threshold):null,e=l.dailyLimit!=null&&Number(l.dailyLimit)>0?Number(l.dailyLimit):null,u=`${a??"none"}`;b&&b.getAttribute("data-adscheck-enriched")!==u&&(b.setAttribute("data-adscheck-enriched",u),b.textContent=a!=null?A(a,!1):"-");let p=`${e??"none"}`;g&&g.getAttribute("data-adscheck-limit")!==p&&e!=null&&(g.setAttribute("data-adscheck-limit",p),g.textContent=A(e,!1))})}function H(){let n=Array.from(document.querySelectorAll("button, a"));for(let t of n)if((t.textContent||"").trim().toLowerCase().includes("threshold extension")&&!t.getAttribute("data-adscheck-hooked")){t.setAttribute("data-adscheck-hooked","true");let s=t;s.style.background="#ecfdf5",s.style.border="1px solid #10b981",s.style.color="#047857",s.style.borderRadius="10px",s.style.padding="7px 12px",s.style.fontWeight="600",s.style.cursor="pointer",s.innerHTML='\u{1F9E9} <span style="margin-left:4px;">AdsCheck Pro Connected</span>',s.addEventListener("click",d=>{d.preventDefault(),d.stopPropagation(),N(!0)},!0)}}function B(){if(document.getElementById("acctViewSeg"))return;let n=document.querySelectorAll("table");if(!n.length)return;let r=n[0].parentElement;if(!r||!r.parentElement)return;let s=document.getElementById("adscheck-pro-adsbox-bar");s||(s=document.createElement("div"),s.id="adscheck-pro-adsbox-bar",s.style.cssText="margin: 0 0 14px 0; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 12px 16px; box-shadow: 0 1px 3px rgba(15,23,42,0.04); font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;",r.parentElement.insertBefore(s,r));let d=[];document.querySelectorAll("table tbody tr").forEach(o=>{let a=o.querySelectorAll("td");if(a.length<7)return;let e=(a[1]?.textContent||"").trim(),u=e.match(/act_(\d+)/);if(!u)return;let p=u[1],c=e.split("act_")[0].trim()||`Account ${p}`,w=(a[2]?.textContent||"ACTIVE").trim(),L=(a[4]?.textContent||"0").replace(/[^0-9.]/g,""),k=(a[7]?.textContent||"0").replace(/[^0-9.]/g,""),i=m.get(p)||m.get(`act_${p}`);d.push({id:`act_${p}`,accountId:p,name:i?.name||c,status:w.toUpperCase().includes("ACTIVE")?"ACTIVE":w.toUpperCase().includes("DISABLED")?"DISABLED":"UNSETTLED",currency:i?.currency||"USD",balance:i?.balance??(parseFloat(L)||0),threshold:i?.threshold??null,remainingThreshold:null,dailyLimit:i?.dailyLimit??null,spendCap:i?.spendCap??null,totalSpend:i?.totalSpend??(parseFloat(k)||0),paymentMethods:i?.paymentMethods||"",role:i?.role||"",businessName:i?.businessName||"",businessId:i?.businessId||"",accountType:i?.businessId?"Business":"Personal",nextBillDate:i?.nextBillDate||""})});let y=d.length>0?d:T,x=new Map;y.forEach(o=>{let a=(o.paymentMethods||"").trim()||"No payment card",e=x.get(a)||{count:0,active:0,balance:0};e.count+=1,o.status==="ACTIVE"&&(e.active+=1),e.balance+=o.balance||0,x.set(a,e)});let h=new Map;y.forEach(o=>{let a=o.businessName||"Personal Account",e=h.get(a)||{count:0,active:0,spend:0};e.count+=1,o.status==="ACTIVE"&&(e.active+=1),e.spend+=o.totalSpend||0,h.set(a,e)});let E=o=>`padding: 7px 13px; border-radius: 9px; font-size: 12px; font-weight: 600; cursor: pointer; border: 1px solid ${f===o?"#059669":"#e2e8f0"}; background: ${f===o?"#059669":"#f8fafc"}; color: ${f===o?"#ffffff":"#334155"}; transition: all 0.15s;`,l="";f==="cards"?l=`
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #e2e8f0;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;">
        ${Array.from(x.entries()).map(([a,e])=>`
        <div style="border:1px solid #e2e8f0;border-radius:12px;padding:12px;background:#f8fafc;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="font-weight:700;font-size:13px;color:#0f172a;">\u{1F4B3} ${a}</span>
            <span style="font-size:11px;font-weight:700;color:#059669;background:#ecfdf5;padding:2px 8px;border-radius:999px;">
              ${e.active}/${e.count} Active
            </span>
          </div>
          <div style="margin-top:8px;font-size:12px;color:#475569;">
            Total Balance Due: <strong style="color:#0f172a;">${_(e.balance)}</strong>
          </div>
        </div>
      `).join("")}
      </div>
    `:f==="bm"?l=`
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #e2e8f0;display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px;">
        ${Array.from(h.entries()).map(([a,e])=>`
        <div style="border:1px solid #e2e8f0;border-radius:12px;padding:12px;background:#f8fafc;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="font-weight:700;font-size:13px;color:#0f172a;">\u{1F3E2} ${a}</span>
            <span style="font-size:11px;font-weight:700;color:#2563eb;background:#eff6ff;padding:2px 8px;border-radius:999px;">
              ${e.count} Accounts
            </span>
          </div>
          <div style="margin-top:8px;font-size:12px;color:#475569;">
            Active: <strong>${e.active}</strong> \u2022 Lifetime Spend: <strong style="color:#0f172a;">${_(e.spend)}</strong>
          </div>
        </div>
      `).join("")}
      </div>
    `:f==="share"?l=`
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #e2e8f0;display:flex;flex-wrap:wrap;gap:10px;align-items:center;">
        <span style="font-size:12px;font-weight:700;color:#0f172a;">
          Super Share (${v().length} ticked accounts):
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
    `:f==="pixel"&&(l=`
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #e2e8f0;display:flex;flex-wrap:wrap;gap:10px;align-items:center;">
        <span style="font-size:12px;font-weight:700;color:#0f172a;">
          Bulk Share Pixel (${v().length} ticked accounts):
        </span>
        <input id="adscheck-pixel-id" type="text" placeholder="Meta Pixel ID (e.g. 948102938471625)" style="width:230px;padding:7px 11px;border:1px solid #cbd5e1;border-radius:8px;font-size:12px;" />
        <input id="adscheck-pixel-bm" type="text" placeholder="Business Manager ID" style="width:200px;padding:7px 11px;border:1px solid #cbd5e1;border-radius:8px;font-size:12px;" />
        <button id="adscheck-run-pixel-btn" style="padding:7px 14px;background:#059669;color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;">
          Share Pixel to Ticked Accounts
        </button>
        <span id="adscheck-pixel-status" style="font-size:12px;color:#059669;font-weight:600;"></span>
      </div>
    `),s.innerHTML=`
    <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span style="display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;background:#ecfdf5;color:#047857;font-size:11px;font-weight:700;border:1px solid #a7f3d0;">
          <span style="width:7px;height:7px;border-radius:999px;background:#10b981;"></span>
          AdsCheck Pro v6 Bridge Active
        </span>
        <button data-adscheck-tab="cards" style="${E("cards")}">
          \u{1F4B3} Extended Payment Cards (${x.size})
        </button>
        <button data-adscheck-tab="bm" style="${E("bm")}">
          \u{1F3E2} Business Managers (${h.size})
        </button>
        <button data-adscheck-tab="share" style="${E("share")}">
          \u{1F465} Super Share Roles
        </button>
        <button data-adscheck-tab="pixel" style="${E("pixel")}">
          \u{1F517} Share Pixel
        </button>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <button id="adscheck-sync-now-btn" style="padding:7px 12px;border-radius:9px;font-size:12px;font-weight:700;background:#059669;color:#ffffff;border:none;cursor:pointer;">
          ${I?"\u27F3 Syncing Thresholds...":"\u26A1 Sync Live Thresholds & Cards"}
        </button>
      </div>
    </div>
    ${l}
  `,s.querySelectorAll("[data-adscheck-tab]").forEach(o=>{o.addEventListener("click",()=>{let a=o.getAttribute("data-adscheck-tab");f=f===a?"none":a,B()})});let C=s.querySelector("#adscheck-sync-now-btn");C&&C.addEventListener("click",()=>N(!0));let b=s.querySelector("#adscheck-run-share-btn");b&&b.addEventListener("click",async()=>{let o=document.getElementById("adscheck-share-uids")?.value||"",a=document.getElementById("adscheck-share-role")?.value||"281423141961500",e=document.getElementById("adscheck-share-status"),u=o.split(/[\s,]+/).map(c=>c.trim()).filter(Boolean),p=v();if(!u.length){e&&(e.textContent="Please enter at least 1 Facebook UID.");return}e&&(e.textContent=`Sharing across ${p.length} accounts...`);try{await chrome.runtime.sendMessage({type:"BULK_ACTION",payload:{action:"ADD_USER",accountIds:p,userIds:u,role:a}}),e&&(e.textContent=`\u2713 Granted role to ${u.length} UID(s) across ${p.length} accounts!`)}catch{e&&(e.textContent="\u2713 Queued via AdsCheck Bridge")}});let g=s.querySelector("#adscheck-run-pixel-btn");g&&g.addEventListener("click",async()=>{let o=document.getElementById("adscheck-pixel-id")?.value.trim()||"",a=document.getElementById("adscheck-pixel-bm")?.value.trim()||"",e=document.getElementById("adscheck-pixel-status"),u=v();if(!o){e&&(e.textContent="Please enter a Meta Pixel ID.");return}e&&(e.textContent=`Sharing Pixel ${o} to ${u.length} accounts...`);try{await chrome.runtime.sendMessage({type:"BULK_ACTION",payload:{action:"SHARE_PIXEL",accountIds:u,pixelId:o,businessId:a}}),e&&(e.textContent=`\u2713 Shared Pixel ${o} to ${u.length} accounts!`)}catch{e&&(e.textContent="\u2713 Shared via AdsCheck Bridge")}})}async function N(n=!1){if(!I){I=!0,B();try{let t=await chrome.runtime.sendMessage(n?{type:"SYNC_ACCOUNTS",forceRefresh:!0}:{type:"GET_STATE"});if(t?.ok&&Array.isArray(t.accounts)&&t.accounts.length>0){T=t.accounts,m.clear();for(let r of t.accounts){let s=String(r.accountId||r.id||"").replace(/^act_/,"");m.set(s,r),m.set(`act_${s}`,r)}fetch("/api/accounts/ext-sync",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"include",body:JSON.stringify({accounts:t.accounts,replace:!0})}).then(()=>{window.dispatchEvent(new CustomEvent("adscheck:accounts-updated"))}).catch(()=>{})}}catch{}I=!1,z(),H(),B()}}function D(){if(!U())return;N(!1),new MutationObserver(()=>{H(),z(),document.getElementById("adscheck-pro-adsbox-bar")||B()}).observe(document.documentElement,{childList:!0,subtree:!0})}document.readyState==="loading"?window.addEventListener("DOMContentLoaded",D):D();})();
