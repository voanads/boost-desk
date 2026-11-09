"use strict";(()=>{var K="__cma_bridge_v10__";window.addEventListener(K,n=>{let t=n.detail;if(!(!t||typeof t!="object"))try{chrome.runtime.sendMessage(t).catch(()=>{})}catch{}});function F(){try{document.documentElement.setAttribute("data-adscheck-extension","installed"),document.documentElement.setAttribute("data-smit-connect","installed"),document.documentElement.setAttribute("data-threshold-extension","installed"),window.postMessage({source:"ADSCHECK_EXT_BRIDGE",type:"EXT_READY",version:"3.1.0",extId:chrome.runtime?.id||""},"*")}catch{}}F();window.addEventListener("DOMContentLoaded",F);window.addEventListener("message",async n=>{if(n.source!==window||!n.data||typeof n.data!="object")return;let t=n.data;if(t.source!=="ADSCHECK_WEB_APP"&&t.source!=="SMIT_WEB_APP"&&t.source!=="ADSBOX_WEB_APP")return;let a=t.requestId||`req_${Date.now()}_${Math.random()}`,s=t.payload||{};try{let l=await chrome.runtime.sendMessage(s);window.postMessage({source:"ADSCHECK_EXT_BRIDGE",type:"EXT_RESPONSE",requestId:a,response:l??{ok:!1,error:"Empty response from extension"}},"*")}catch(l){window.postMessage({source:"ADSCHECK_EXT_BRIDGE",type:"EXT_RESPONSE",requestId:a,response:{ok:!1,error:String(l?.message||l)}},"*")}});var m=new Map,$=[],f="none",T=!1;function W(){if(document.documentElement.getAttribute("data-adscheck-standalone")==="true")return!1;let n=window.location.hostname,t=window.location.pathname+window.location.hash;return!!(n.includes("boost-desk")||n.includes("railway.app")||t.includes("projectmanager")||document.title.toLowerCase().includes("ads box"))}function R(n,t="USD"){if(n==null||Number.isNaN(Number(n)))return"\u2014";try{return new Intl.NumberFormat("en-US",{style:"currency",currency:t||"USD",maximumFractionDigits:t==="VND"?0:2}).format(Number(n))}catch{return`$${Number(n).toFixed(2)}`}}function v(){let n=[];return document.querySelectorAll("table tbody tr").forEach(a=>{let l=(a.textContent||"").match(/act_(\d+)/);if(!l)return;let y=a.querySelector('input[type="checkbox"]');(!y||y.checked)&&n.push(l[1])}),n.length===0&&$.length>0?$.map(a=>a.accountId):n}function w(n,t=!0){if(n==null||Number.isNaN(Number(n)))return t?"0":"-";let a=Math.round(Number(n)*100)/100;return a===0&&!t?"-":a.toLocaleString("en-US",{minimumFractionDigits:0,maximumFractionDigits:2})}function O(){let n=document.querySelectorAll("table tbody tr");!n.length||m.size===0||n.forEach(t=>{let a=t.getAttribute("data-smit-row");if(a){let i=m.get(a)||m.get(`act_${a}`);if(!i)return;let k=t.querySelector('[data-smit-cell="orig"]'),L=t.querySelector('[data-smit-cell="balance"]'),S=t.querySelector('[data-smit-cell="threshold"]'),c=t.querySelector('[data-smit-cell="remain"]'),D=t.querySelector('[data-smit-cell="limit"]');if(k&&i.businessId&&(k.textContent||"").trim()==="-"){let C=`https://business.facebook.com/settings/ad-accounts?business_id=${encodeURIComponent(i.businessId)}`;k.innerHTML=`<a class="smit-orig-link" href="${C}" target="_blank" rel="noopener">${i.businessId}</a>`}let j=i.balance??(parseFloat((L?.textContent||"").replace(/[^0-9.-]/g,""))||0),I=i.threshold!=null&&Number(i.threshold)>0?Number(i.threshold):null,P=i.dailyLimit!=null&&Number(i.dailyLimit)>0?Number(i.dailyLimit):i.spendCap!=null&&Number(i.spendCap)>0?Number(i.spendCap):null,_=(C,M,q,X)=>{if(!C)return;let z=C.querySelector("a");z?z.textContent=M:q?C.innerHTML=`<a class="${X||"smit-billing-link"}" href="${q}" target="_blank" rel="noopener">${M}</a>`:C.textContent=M},H=`https://business.facebook.com/billing_hub/accounts/details?asset_id=${encodeURIComponent(a)}`,G=`https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${encodeURIComponent(a)}`;S&&I!=null&&_(S,w(I,!1),H,"smit-billing-link"),c&&I!=null&&_(c,w(Math.round(I-j),!0),H,"smit-billing-link"),D&&P!=null&&_(D,w(P,!1),G,"smit-acct-link-num");return}let s=t.querySelectorAll("td");if(s.length<7)return;let b=(s[1]?.textContent||"").match(/act_(\d+)/);if(!b)return;let h=b[1],E=`act_${h}`,d=m.get(h)||m.get(E);if(!d)return;let A=s[4],x=s[5],g=s[6],o=d.balance??(parseFloat((A?.textContent||"").replace(/[^0-9.]/g,""))||0),r=d.threshold!=null&&Number(d.threshold)>0?Number(d.threshold):null,e=d.dailyLimit!=null&&Number(d.dailyLimit)>0?Number(d.dailyLimit):null,u=`${r??"none"}`;x&&x.getAttribute("data-adscheck-enriched")!==u&&(x.setAttribute("data-adscheck-enriched",u),x.textContent=r!=null?w(r,!1):"-");let p=`${e??"none"}`;g&&g.getAttribute("data-adscheck-limit")!==p&&e!=null&&(g.setAttribute("data-adscheck-limit",p),g.textContent=w(e,!1))})}function V(){let n=Array.from(document.querySelectorAll("button, a"));for(let t of n)if((t.textContent||"").trim().toLowerCase().includes("threshold extension")&&!t.getAttribute("data-adscheck-hooked")){t.setAttribute("data-adscheck-hooked","true");let s=t;s.style.background="#ecfdf5",s.style.border="1px solid #10b981",s.style.color="#047857",s.style.borderRadius="10px",s.style.padding="7px 12px",s.style.fontWeight="600",s.style.cursor="pointer",s.innerHTML='\u{1F9E9} <span style="margin-left:4px;">AdsCheck Pro Connected</span>',s.addEventListener("click",l=>{l.preventDefault(),l.stopPropagation(),N(!0)},!0)}}function B(){if(document.getElementById("acctViewSeg"))return;let n=document.querySelectorAll("table");if(!n.length)return;let a=n[0].parentElement;if(!a||!a.parentElement)return;let s=document.getElementById("adscheck-pro-adsbox-bar");s||(s=document.createElement("div"),s.id="adscheck-pro-adsbox-bar",s.style.cssText="margin: 0 0 14px 0; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 12px 16px; box-shadow: 0 1px 3px rgba(15,23,42,0.04); font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;",a.parentElement.insertBefore(s,a));let l=[];document.querySelectorAll("table tbody tr").forEach(o=>{let r=o.querySelectorAll("td");if(r.length<7)return;let e=(r[1]?.textContent||"").trim(),u=e.match(/act_(\d+)/);if(!u)return;let p=u[1],i=e.split("act_")[0].trim()||`Account ${p}`,k=(r[2]?.textContent||"ACTIVE").trim(),L=(r[4]?.textContent||"0").replace(/[^0-9.]/g,""),S=(r[7]?.textContent||"0").replace(/[^0-9.]/g,""),c=m.get(p)||m.get(`act_${p}`);l.push({id:`act_${p}`,accountId:p,name:c?.name||i,status:k.toUpperCase().includes("ACTIVE")?"ACTIVE":k.toUpperCase().includes("DISABLED")?"DISABLED":"UNSETTLED",currency:c?.currency||"USD",balance:c?.balance??(parseFloat(L)||0),threshold:c?.threshold??null,remainingThreshold:null,dailyLimit:c?.dailyLimit??null,spendCap:c?.spendCap??null,totalSpend:c?.totalSpend??(parseFloat(S)||0),paymentMethods:c?.paymentMethods||"",role:c?.role||"",businessName:c?.businessName||"",businessId:c?.businessId||"",accountType:c?.businessId?"Business":"Personal",nextBillDate:c?.nextBillDate||""})});let y=l.length>0?l:$,b=new Map;y.forEach(o=>{let r=(o.paymentMethods||"").trim()||"No payment card",e=b.get(r)||{count:0,active:0,balance:0};e.count+=1,o.status==="ACTIVE"&&(e.active+=1),e.balance+=o.balance||0,b.set(r,e)});let h=new Map;y.forEach(o=>{let r=o.businessName||"Personal Account",e=h.get(r)||{count:0,active:0,spend:0};e.count+=1,o.status==="ACTIVE"&&(e.active+=1),e.spend+=o.totalSpend||0,h.set(r,e)});let E=o=>`padding: 7px 13px; border-radius: 9px; font-size: 12px; font-weight: 600; cursor: pointer; border: 1px solid ${f===o?"#059669":"#e2e8f0"}; background: ${f===o?"#059669":"#f8fafc"}; color: ${f===o?"#ffffff":"#334155"}; transition: all 0.15s;`,d="";f==="cards"?d=`
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #e2e8f0;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;">
        ${Array.from(b.entries()).map(([r,e])=>`
        <div style="border:1px solid #e2e8f0;border-radius:12px;padding:12px;background:#f8fafc;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="font-weight:700;font-size:13px;color:#0f172a;">\u{1F4B3} ${r}</span>
            <span style="font-size:11px;font-weight:700;color:#059669;background:#ecfdf5;padding:2px 8px;border-radius:999px;">
              ${e.active}/${e.count} Active
            </span>
          </div>
          <div style="margin-top:8px;font-size:12px;color:#475569;">
            Total Balance Due: <strong style="color:#0f172a;">${R(e.balance)}</strong>
          </div>
        </div>
      `).join("")}
      </div>
    `:f==="bm"?d=`
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #e2e8f0;display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px;">
        ${Array.from(h.entries()).map(([r,e])=>`
        <div style="border:1px solid #e2e8f0;border-radius:12px;padding:12px;background:#f8fafc;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="font-weight:700;font-size:13px;color:#0f172a;">\u{1F3E2} ${r}</span>
            <span style="font-size:11px;font-weight:700;color:#2563eb;background:#eff6ff;padding:2px 8px;border-radius:999px;">
              ${e.count} Accounts
            </span>
          </div>
          <div style="margin-top:8px;font-size:12px;color:#475569;">
            Active: <strong>${e.active}</strong> \u2022 Lifetime Spend: <strong style="color:#0f172a;">${R(e.spend)}</strong>
          </div>
        </div>
      `).join("")}
      </div>
    `:f==="share"?d=`
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
    `:f==="pixel"&&(d=`
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
          \u{1F4B3} Extended Payment Cards (${b.size})
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
          ${T?"\u27F3 Syncing Thresholds...":"\u26A1 Sync Live Thresholds & Cards"}
        </button>
      </div>
    </div>
    ${d}
  `,s.querySelectorAll("[data-adscheck-tab]").forEach(o=>{o.addEventListener("click",()=>{let r=o.getAttribute("data-adscheck-tab");f=f===r?"none":r,B()})});let A=s.querySelector("#adscheck-sync-now-btn");A&&A.addEventListener("click",()=>N(!0));let x=s.querySelector("#adscheck-run-share-btn");x&&x.addEventListener("click",async()=>{let o=document.getElementById("adscheck-share-uids")?.value||"",r=document.getElementById("adscheck-share-role")?.value||"281423141961500",e=document.getElementById("adscheck-share-status"),u=o.split(/[\s,]+/).map(i=>i.trim()).filter(Boolean),p=v();if(!u.length){e&&(e.textContent="Please enter at least 1 Facebook UID.");return}e&&(e.textContent=`Sharing across ${p.length} accounts...`);try{await chrome.runtime.sendMessage({type:"BULK_ACTION",payload:{action:"ADD_USER",accountIds:p,userIds:u,role:r}}),e&&(e.textContent=`\u2713 Granted role to ${u.length} UID(s) across ${p.length} accounts!`)}catch{e&&(e.textContent="\u2713 Queued via AdsCheck Bridge")}});let g=s.querySelector("#adscheck-run-pixel-btn");g&&g.addEventListener("click",async()=>{let o=document.getElementById("adscheck-pixel-id")?.value.trim()||"",r=document.getElementById("adscheck-pixel-bm")?.value.trim()||"",e=document.getElementById("adscheck-pixel-status"),u=v();if(!o){e&&(e.textContent="Please enter a Meta Pixel ID.");return}e&&(e.textContent=`Sharing Pixel ${o} to ${u.length} accounts...`);try{await chrome.runtime.sendMessage({type:"BULK_ACTION",payload:{action:"SHARE_PIXEL",accountIds:u,pixelId:o,businessId:r}}),e&&(e.textContent=`\u2713 Shared Pixel ${o} to ${u.length} accounts!`)}catch{e&&(e.textContent="\u2713 Shared via AdsCheck Bridge")}})}async function N(n=!1){if(!T){T=!0,B();try{let t=await chrome.runtime.sendMessage(n?{type:"SYNC_ACCOUNTS",forceRefresh:!0}:{type:"GET_STATE"});if(t?.ok&&Array.isArray(t.accounts)&&t.accounts.length>0){$=t.accounts,m.clear();for(let a of t.accounts){let s=String(a.accountId||a.id||"").replace(/^act_/,"");m.set(s,a),m.set(`act_${s}`,a)}fetch("/api/accounts/ext-sync",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"include",body:JSON.stringify({accounts:t.accounts,replace:!0})}).then(()=>{window.dispatchEvent(new CustomEvent("adscheck:accounts-updated"))}).catch(()=>{})}}catch{}T=!1,O(),V(),B()}}function U(){if(!W())return;N(!1),new MutationObserver(()=>{V(),O(),document.getElementById("adscheck-pro-adsbox-bar")||B()}).observe(document.documentElement,{childList:!0,subtree:!0})}document.readyState==="loading"?window.addEventListener("DOMContentLoaded",U):U();})();
