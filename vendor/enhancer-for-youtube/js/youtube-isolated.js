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
(f=>{window.wrappedJSObject||(chrome.runtime.onMessage.addListener(a=>{"command"===a.message?document.dispatchEvent(new CustomEvent("efyt-command",{detail:{command:a.command,control:a.control}})):"preference-changed"===a.message&&document.dispatchEvent(new CustomEvent("efyt-preference-changed",{detail:{name:a.name,value:a.value,oldvalue:a.oldvalue}}))}),document.addEventListener("efyt-message",async a=>{a=a.detail;try{if("pop-up-player"===a.request){var b="https://www.youtube-nocookie.com/pop-up-player/",
c=(await chrome.storage.local.get({popuplayersize:f.popuplayersize})).popuplayersize.split("x"),d={request:a.request};a.playlist?(await chrome.storage.local.set({playlist:a.params}),b+=a.params.videos[a.params.index]+"?autoplay=1"):b+=a.params;d.options={url:b,type:"popup",height:parseInt(c[1],10)+9+30,width:parseInt(c[0],10)+16,incognito:chrome.extension.inIncognitoContext,focused:!0};a=d}if("pop-up-player"===a.request&&window.open){var w=window.open(a.options.url,"_blank","popup=yes,width="+a.options.width+",height="+a.options.height);if(w)return}chrome.runtime.sendMessage(a)}catch(e){document.body.classList.add("efyt-reload-message")}}),document.addEventListener("efyt-get-messages",
()=>{try{var a=chrome.i18n.getMessage("locale_code"),b="boost_volume brightness cinema_mode color_inversion contrast custom_script expand experiments experiments_heading experiments_subheading experiments_modern_player experiments_ultra_wide_player experiments_cancel experiments_submit flip_horizontally flip_vertically gaussian_blur grayscale hue_rotation keyboard_shortcuts locale_dir loop loop_end loop_start message options page_reload_required pop_up_player reset reverse_playlist saturation screenshot sepia shrink speed stop toggle_visibility video_filters".split(" ");
chrome.storage.local.get({localecode:f.localecode,whatsnew:f.whatsnew},c=>{var d={};if(a===c.localecode){for(var e=b.length-1;0<=e;e--)d[b[e]]=chrome.i18n.getMessage(b[e]);document.dispatchEvent(new CustomEvent("efyt-set-messages",{detail:{messages:d}}))}else fetch(chrome.runtime.getURL(`_locales/${c.localecode}/messages.json`)).then(g=>g.json()).then(g=>{for(var h=b.length-1;0<=h;h--)d[b[h]]=g[b[h]].message;document.dispatchEvent(new CustomEvent("efyt-set-messages",{detail:{messages:d}}))});c.whatsnew&&
chrome.runtime.sendMessage({request:"whats-new"}).then(()=>{document.dispatchEvent(new Event("efyt-whats-new"));setTimeout(()=>{document.dispatchEvent(new Event("efyt-whats-new"))},2E3)}).catch(g=>{})})}catch(c){document.body.classList.add("efyt-reload-message")}}),document.addEventListener("efyt-video-filters",a=>{chrome.storage.local.set({filter:a.detail.filter,videofilters:a.detail.videofilters})}),chrome.storage.local.get(f,a=>{document.dispatchEvent(new CustomEvent("efyt-init",{detail:{prefs:a,
reload:a.reload,version:chrome.runtime.getManifest().version,previousversion:a.previousversion,themes:chrome.runtime.getURL("css/themes/"),vendorthemes:chrome.runtime.getURL("vendor/themes/")}}));a.reload&&setTimeout(()=>{chrome.storage.local.set({reload:!1})},5E3)}))})(config);