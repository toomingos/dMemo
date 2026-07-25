#!/usr/bin/env node
const DMEMO_IMPORT_META_URL = require("url").pathToFileURL(__filename).href;
"use strict";var C=Object.create;var a=Object.defineProperty;var _=Object.getOwnPropertyDescriptor;var b=Object.getOwnPropertyNames;var F=Object.getPrototypeOf,H=Object.prototype.hasOwnProperty;var E=(o,e)=>{for(var n in e)a(o,n,{get:e[n],enumerable:!0})},u=(o,e,n,s)=>{if(e&&typeof e=="object"||typeof e=="function")for(let r of b(e))!H.call(o,r)&&r!==n&&a(o,r,{get:()=>e[r],enumerable:!(s=_(e,r))||s.enumerable});return o};var m=(o,e,n)=>(n=o!=null?C(F(o)):{},u(e||!o||!o.__esModule?a(n,"default",{value:o,enumerable:!0}):n,o)),x=o=>u(a({},"__esModule",{value:!0}),o);var P={};E(P,{install:()=>p,uninstall:()=>y});module.exports=x(P);var t=m(require("node:fs"),1),d=m(require("node:os"),1),i=m(require("node:path"),1),O="DMEMO_HOOK=1";function c(){return process.env.CODEX_HOME??i.default.join(d.default.homedir(),".codex")}function f(){return i.default.join(c(),"hooks.json")}function l(){return i.default.join(c(),"config.toml")}function v(){return i.default.dirname(__dirname)}function $(o){let e=i.default.join(__dirname,"hooks-template.json"),n=t.default.readFileSync(e,"utf8").split("${PLUGIN_ROOT}").join(o);return JSON.parse(n)}function g(){let o=f();if(!t.default.existsSync(o))return{hooks:{}};try{return JSON.parse(t.default.readFileSync(o,"utf8"))}catch(e){throw new Error(`failed to read ${o}: ${e instanceof Error?e.message:String(e)}`)}}function w(o){return(o.hooks??[]).some(e=>typeof e.command=="string"&&e.command.includes(O))}function k(o){let e=o.hooks??{};for(let n of Object.keys(e))e[n]=(e[n]??[]).filter(s=>!w(s)),e[n].length===0&&delete e[n];return o.hooks=e,o}function j(o,e){let n=o.hooks??={};for(let[s,r]of Object.entries(e.hooks??{}))n[s]=[...n[s]??[],...r];return o}function h(o){t.default.mkdirSync(c(),{recursive:!0}),t.default.writeFileSync(f(),JSON.stringify(o,null,2)+`
`)}function M(){let o=l();return t.default.existsSync(o)?t.default.readFileSync(o,"utf8").split(`
`).some(n=>n.split("#",1)[0].replace(/\s+/g,"")==="codex_hooks=true"):!1}function R(){let o=l(),e=t.default.existsSync(o)?t.default.readFileSync(o,"utf8"):"",n=!1,s=!1;M()||(/^\[features\]\s*$/m.test(e)?e=e.replace(/^\[features\]\s*$/m,`[features]
codex_hooks = true`):e+=`${e.endsWith(`
`)||e===""?"":`
`}
[features]
codex_hooks = true
`,n=!0);let r=/generate_memories\s*=\s*false/.test(e),S=/use_memories\s*=\s*false/.test(e);return(!r||!S)&&(/^\[memories\]\s*$/m.test(e)?e=e.replace(/^\[memories\]\s*$/m,`[memories]
generate_memories = false
use_memories = false`):e+=`${e.endsWith(`
`)||e===""?"":`
`}
[memories]
generate_memories = false
use_memories = false
`,s=!0),(n||s)&&(t.default.mkdirSync(c(),{recursive:!0}),t.default.writeFileSync(o,e)),{addedFeatureFlag:n,addedMemoryDisable:s}}function p(o=v()){let e=g();e=k(e);let n=$(o);e=j(e,n),h(e);let{addedFeatureFlag:s,addedMemoryDisable:r}=R();console.log(`Installed dMemo hooks into ${f()}`),console.log(`Plugin path: ${o}`),console.log("Events: SessionStart, UserPromptSubmit, Stop, PreCompact"),s&&console.log(`Enabled [features] codex_hooks = true in ${l()}`),r&&console.log(`Disabled Codex's native memory subsystem in ${l()}`)}function y(){let o=k(g());h(o),console.log(`Removed dMemo hooks from ${f()}`)}function D(){return process.platform==="win32"?(console.error("Codex lifecycle hooks on native Windows require a shell capable of the `VAR=1 node ...` command form used here. Re-run this installer from WSL or Git Bash."),2):process.argv.slice(2).includes("--uninstall")?(y(),0):(p(),0)}require.main===module&&(process.exitCode=D());0&&(module.exports={install,uninstall});
