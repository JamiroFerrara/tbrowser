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
(d=>{window.wrappedJSObject||(chrome.storage.onChanged.addListener(a=>{for(const b in a)void 0!==a[b].newValue&&Object.hasOwn(d,b)&&document.dispatchEvent(new CustomEvent("efyt-preference-changed",{detail:{name:b,value:a[b].newValue}}))}),chrome.storage.local.get(d,async a=>{var b=chrome.i18n.getMessage("locale_code"),e={screenshot:chrome.i18n.getMessage("screenshot")};b!==a.localecode&&await fetch(chrome.runtime.getURL(`_locales/${a.localecode}/messages.json`)).then(c=>c.json()).then(c=>
{e.screenshot=c.screenshot.message}).catch(()=>{});document.dispatchEvent(new CustomEvent("efyt-init",{detail:{prefs:a,version:chrome.runtime.getManifest().version,messages:e}}))}))})(configEmbed);