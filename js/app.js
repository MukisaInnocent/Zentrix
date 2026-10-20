const BRAND="Zentrix";
const P={
layout:'<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
wallet:'<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
users:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
book:'<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
user:'<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
mail:'<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
logout:'<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',
down:'<path d="M17 7 7 17M17 17H7V7"/>',
up:'<path d="M7 7h10v10M7 17 17 7"/>',
trend:'<path d="M22 7 13.5 15.5 8.5 10.5 2 17"/><path d="M16 7h6v6"/>',
copy:'<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
eye:'<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7"/><circle cx="12" cy="12" r="3"/>',
gift:'<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/>',
phone:'<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
file:'<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8"/>',
chart:'<path d="M3 3v18h18M18 17V9M13 17V5M8 17v-3"/>',
send:'<path d="m22 2-7 20-4-9-9-4zM22 2 11 13"/>',
ticket:'<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z"/><path d="M13 5v2M13 11v2M13 17v2"/>',
card:'<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
message:'<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z"/>',
briefcase:'<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
refresh:'<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5"/>',
target:'<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
film:'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4M3 12h18M3 16h4M17 8h4M17 16h4"/>',
megaphone:'<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
news:'<path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8M15 18h-5M10 6h8v4h-8z"/>',
userplus:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
monitor:'<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
music:'<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
video:'<rect x="2" y="4" width="20" height="16" rx="4"/><path d="m10 9 5 3-5 3z"/>',
help:'<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01"/>',
chevr:'<path d="m9 18 6-6-6-6"/>'};
const svg=n=>`<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n]||""}</svg>`;
const NAV=[["Main",[["Dashboard","layout","dashboard"]]],["Accounts",[["Voucher","ticket","voucher",[["Buy voucher","buy"],["My vouchers","mine"],["Redeem","redeem"]]],["Deposit","down","deposit"],["PayForClient","card","payforclient"],["Withdraw","up","withdraw",[["Request","request"],["History","history"]]],["Whatsapp","message","whatsapp"],["Team","users","team",[["My team","team"],["Referral link","link"],["Commissions","commissions"]]],["Accounts","briefcase","accounts",[["Overview","overview"],["Statements","statements"]]]]],["Products",[["Spin & Win","refresh","spin",[["Play","play"],["History","history"]]],["Fixed Bets","target","bets",[["Today’s slips","tips"],["My bets","mine"]]],["Movies","film","movies",[["Browse","browse"],["Watchlist","watchlist"]]],["Meta ADS","megaphone","meta",[["Create campaign","create"],["My campaigns","campaigns"]]],["Articles","news","articles",[["Read","read"],["Submit article","submit"]]],["Forex Lessons","chart","forex"],["Claim Followers","userplus","followers"],["Ads Earnings","monitor","adsearn"],["Tiktok Earn","music","tiktok",[["Tasks","tasks"],["Submissions","submissions"]]],["Youtube Earn","video","youtube",[["Tasks","tasks"],["Submissions","submissions"]]],["Trivia Challenge","help","trivia",[["Play","play"],["Leaderboard","board"]]],["Business Ebooks","book","ebooks"]]],["Settings",[["Profile","user","profile"],["Contact US","mail","contact"],["Log Out","logout","login"]]]];
const page=document.body.dataset.page;
if(page!=="login"&&page!=="index"&&page!=="payment"){
  const nav=NAV.map(([g,items])=>`<h4>${g}</h4>`+items.map(([t,i,p,subs])=>subs?`<a class="item has${p===page?" on open":""}" href="${p}.html#${subs[0][1]}"><i data-i="${i}"></i>${t}<span class="chev"><i data-i="chevr"></i></span></a><div class="subnav">${subs.map(([n,x])=>`<a href="${p}.html#${x}">${n}</a>`).join("")}</div>`:`<a class="item${p===page?" on":""}" href="${p}.html"><i data-i="${i}"></i>${t}</a>`).join("")).join("");
  document.body.insertAdjacentHTML("afterbegin",`<aside class="side"><a class="logo" href="dashboard.html"><span class="mark"></span>${BRAND}</a>${nav}</aside><div class="ov"></div><header class="top"><button id="mb" aria-label="Open menu"><i data-i="menu"></i></button><span></span><div class="user"><span>Demo User</span><span class="av">DU</span></div></header>`);
  document.querySelector("main").insertAdjacentHTML("beforeend",`<p class="foot">© ${new Date().getFullYear()} ${BRAND}.</p>`);
  document.querySelector(".ov").onclick=()=>document.body.classList.remove("open");
  document.getElementById("mb").onclick=()=>document.body.classList.toggle("open");
}
document.querySelectorAll("[data-i]").forEach(e=>e.outerHTML=svg(e.dataset.i));
document.querySelectorAll("[data-copy]").forEach(b=>b.onclick=()=>{const t=document.querySelector(b.dataset.copy);try{navigator.clipboard.writeText(t.value||t.textContent)}catch(e){}b.lastChild.textContent=" Copied"});
document.querySelectorAll("[data-toggle]").forEach(b=>b.onclick=()=>{const i=document.getElementById(b.dataset.toggle);i.type=i.type==="password"?"text":"password"});
document.querySelectorAll("form[data-demo]").forEach(f=>f.onsubmit=e=>{e.preventDefault();if(f.dataset.demo)location.href=f.dataset.demo;else f.querySelector("button[type=submit]").textContent="Saved (demo)"});
document.querySelectorAll(".item.has").forEach(a=>a.addEventListener("click",e=>{if(a.classList.contains("on")){e.preventDefault();a.classList.toggle("open")}}));
const secs=[...document.querySelectorAll("[data-tab]")];
if(secs.length){const bar=document.createElement("div");bar.className="tabs";bar.innerHTML=secs.map(s=>`<a href="#${s.dataset.tab}" data-t="${s.dataset.tab}">${s.dataset.title}</a>`).join("");secs[0].before(bar);
 const show=()=>{const h=location.hash.slice(1)||secs[0].dataset.tab;secs.forEach(s=>s.hidden=s.dataset.tab!==h);bar.querySelectorAll("a").forEach(a=>a.classList.toggle("on",a.dataset.t===h));document.querySelectorAll(".subnav a").forEach(a=>a.classList.toggle("on",a.getAttribute("href")===page+".html#"+h))};
 addEventListener("hashchange",show);show()}
document.querySelectorAll("[data-spin]").forEach(b=>b.onclick=()=>{const w=document.querySelector(b.dataset.spin),o=document.getElementById("spinout"),pr=["UGX 0 – try again","UGX 50","UGX 100","UGX 200","Free spin"];w._r=(w._r||0)+720+Math.floor(Math.random()*360);w.style.transform=`rotate(${w._r}deg)`;o.textContent="Spinning…";setTimeout(()=>o.textContent="Result: "+pr[Math.floor(Math.random()*pr.length)],2600)});
document.querySelectorAll(".opt").forEach(b=>b.onclick=()=>{const g=b.parentElement;g.querySelectorAll(".opt").forEach(x=>{x.disabled=true;if(x.dataset.ok!==undefined)x.classList.add("good")});if(b.dataset.ok===undefined)b.classList.add("bad")});
const backendScript=document.createElement("script");backendScript.src="js/backend.js";document.body.append(backendScript);
