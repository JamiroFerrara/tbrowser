/*
##
##  Enhancer for YouTube™
##  =====================
##
##  Author: Max RF <https://www.mrfdev.com>
##
##  This file is protected by copyright laws and international copyright
##  treaties, as well as other intellectual property laws and treaties.
##
##  All rights not expressly granted to you are retained by the author.
##  Read the license.txt file for more details.
##
##  © MRFDEV.com - All Rights Reserved
##
*/
(c=>{function w(a){c.body.classList.add("overflow-hidden");g.style.display="block";a.style.display="block";a.scrollTop=0;g.classList.add("in");setTimeout(()=>{c.body.classList.add("modal-open");a.querySelector("button.close-modal").focus()},50)}function x(a){c.body.classList.remove("modal-open");setTimeout(()=>{a.style.display="none";g.classList.add("fade");g.classList.remove("in");setTimeout(()=>{g.style.display="none";c.body.classList.remove("overflow-hidden");c.querySelector("#generate-code-btn").focus()},
300)},300)}function q(){var a=c.querySelector("main"),b=c.createElement("style");b.textContent=`:root{--main-inset-shadow-top:${a.offsetTop}px;--main-inset-shadow-width:${a.clientWidth}px}`;c.head.appendChild(b)}var l,r,y="am fil gu kn ml mr sw ta te".split(" "),t={ca:["color","contrast","controls","sepia","videos"],cs:["stop"],da:"backup hue_rotation loop loop_start stop support sepia variant".split(" "),de:"autoplay backup export import loop_start playlists screenshot sepia stop videos".split(" "),
el:["theme"],es:["color","sepia"],es_419:["color","sepia","videos"],et:["variant"],fr:["options","support","volume","stop","message"],hr:["autoplay","mini_player","save","video_player"],id:"autoplay backup gaussian_blur reset screenshot sepia stop volume".split(" "),it:"backup loop mini_player mouse playlists reset screenshot sepia volume".split(" "),ms:["import","sepia"],nl:"autoplay filters support contrast sepia variant volume".split(" "),no:["loop_start","sepia","variant"],pl:["sepia"],pt_BR:"backup loop mini_player mouse playlists volume".split(" "),
pt_PT:["backup","volume"],ro:["backup","gaussian_blur","contrast","mouse","sepia"],sk:["message"],sl:["sepia"],sr:["sepia"],sv:["loop","support","sepia","variant"],vi:["videos"]};c.querySelectorAll("nav a").forEach(a=>{a.addEventListener("focus",function(){this.parentNode.classList.add("focus")});a.addEventListener("blur",function(){this.parentNode.classList.remove("focus")})});var h=c.querySelector("#locale"),d=c.querySelectorAll("[contenteditable]"),m=c.querySelector("#description"),n=c.querySelector("#generate-code-btn");
h.addEventListener("change",function(){l=h.options[h.selectedIndex].dataset.dir;r=h.options[h.selectedIndex].textContent;if(""===this.value||0<=y.indexOf(this.value)){for(var a=d.length-1;0<=a;a--)d[a].textContent="",d[a].dir="ltr";n.disabled=""===this.value?!0:!1}else fetch(chrome.runtime.getURL(`_locales/${this.value}/messages.json`)).then(b=>b.json()).then(b=>{for(var e=d.length-1,k;0<=e;e--)k=b[d[e].id].message,"en_US"===b.locale_code.message||"en_GB"===b.locale_code.message?d[e].innerText=k:
k!==d[e].previousElementSibling.innerText||t[b.locale_code.message]&&0<=t[b.locale_code.message].indexOf(d[e].id)?d[e].innerText=k:d[e].textContent="",d[e].dir=l;n.disabled=!1})});m.addEventListener("keyup",function(){132<this.textContent.length&&(this.textContent=this.textContent.substr(0,132),this.blur())});n.addEventListener("click",()=>{var a={},b=c.querySelector("#locale").value;if(""!==b){a.locale_code={message:b};a.locale_dir={message:l};b=0;for(var e;b<d.length;b++)e=d[b].innerText.trim(),
""===e&&(e=d[b].previousElementSibling.innerText),a[d[b].id]={message:e};z.textContent=`${r} Translation - Enhancer for YouTube\u2122`;u.value=JSON.stringify(a).replace(/^\{/,"{\n  ").replace(/":\{"/gm,'": {"').replace(/":"/gm,'": "').replace(/"\},"/gm,'"},\n  "').replace(/\}$/,"\n}");w(f)}});var g=c.querySelector("#modal-backdrop"),f=c.querySelector("#i18n-modal"),z=f.querySelector(".modal-title"),v=f.querySelector(".close-modal"),u=f.querySelector("#code");m=f.querySelector("#copy-to-clipboard-btn");
var p=f.querySelector("#copy-to-clipboard-checkmark");v.addEventListener("click",()=>{x(f)});m.addEventListener("click",async()=>{await navigator.clipboard.writeText(u.value);p.classList.add("show")});p.addEventListener("animationend",a=>{"checkmark-scale"===a.animationName&&setTimeout(()=>{p.classList.remove("show")},1200)});c.addEventListener("keydown",a=>{"Escape"===a.key&&v.click()});window.addEventListener("resize",q);q()})(document);