// The stylesheet of the mock workspace. It follows the Slack desktop client: Lato, 15px/22px
// message text, a 40px title bar, a 70px tab rail, a 260px sidebar and a rounded workspace card.
//
// Two groups of variables drive every colour:
// - `--t-*` is the sidebar theme, the eight values of a Slack custom theme string in order:
//   column bg, menu bg hover, active item, active item text, hover item, text colour,
//   active presence, mention badge. The defaults are the Hive themes of Agent Swarm.
// - the rest is the message pane, which Slack never themes: its stock light and dark palettes.

import { LATO } from "./fonts.ts";
import { iconMask } from "./icons.ts";

/** Hive light and Hive dark, as published in the Agent Swarm README ("Slack theme"). */
export const THEMES = {
  light: "#FAFAFA,#F4F4F5,#BB4D00,#FAFAFA,#F4F4F5,#09090B,#00BC7D,#E7000B",
  dark: "#18181B,#27272A,#FE9A00,#09090B,#27272A,#FAFAFA,#00C951,#FF6467",
} as const;

export type ThemeName = keyof typeof THEMES;

const THEME_VARS = ["col", "menu", "active", "active-fg", "hover", "fg", "presence", "badge"];

function themeVars(name: ThemeName): string {
  return THEMES[name]
    .split(",")
    .map((value, i) => `--t-${THEME_VARS[i]}:${value}`)
    .join(";");
}

const LIGHT = `${themeVars("light")};color-scheme:light;--bg:#fff;--fg:#1d1c1d;--fg2:#616061;--fg3:#868686;--line:#e2e2e2;--line2:#bbb;--hover:#f8f8f8;--inset:#f6f6f6;--react:#efefef;--raised:#fff;--link:#1264a3;--pill-bg:#e8f5fa;--pill-hover:#d3ecf6;--pill-fg:#1264a3;--code:#e01e5a;--green:#007a5a;--green-hover:#148567;--red:#e01e5a;--warn-bg:#fdf6e3;--warn-fg:#8a6d1a;--chip-bg:#f1f1f3;--chip-hover:#e6e6e9;--accent:var(--t-active);--float:0 0 0 1px rgba(29,28,29,.13),0 4px 12px rgba(0,0,0,.12);--pop:0 0 0 1px rgba(29,28,29,.13),0 8px 32px rgba(0,0,0,.2)`;

const DARK = `${themeVars("dark")};color-scheme:dark;--bg:#1a1d21;--fg:#d1d2d3;--fg2:#ababad;--fg3:#868686;--line:#35373b;--line2:#565856;--hover:#222529;--inset:#222529;--react:#2a2d31;--raised:#222529;--link:#1d9bd1;--pill-bg:#1d3a4b;--pill-hover:#22485d;--pill-fg:#36a3d9;--code:#e8912d;--green:#007a5a;--green-hover:#148567;--red:#e96379;--warn-bg:#3a3222;--warn-fg:#e0c069;--chip-bg:#2c2d31;--chip-hover:#3a3b40;--accent:var(--t-active);--float:0 0 0 1px rgba(232,232,232,.13),0 4px 12px rgba(0,0,0,.4);--pop:0 0 0 1px rgba(232,232,232,.13),0 8px 32px rgba(0,0,0,.5)`;

const MONO = `Monaco,Menlo,Consolas,"Courier New",monospace`;

/** A text-glyph control (×, ⤢, ←) drawn as an icon: the glyph stays in the markup for readers. */
function glyphIcon(selector: string, name: string, size = 20): string {
  return `${selector}{font-size:0;display:inline-flex;align-items:center;justify-content:center}${selector}:before{content:"";width:${size}px;height:${size}px;background:currentColor;-webkit-mask:${iconMask(name)};mask:${iconMask(name)}}`;
}

const CSS = `
:root{${LIGHT}}
:root[data-theme=dark]{${DARK}}
*{box-sizing:border-box}
html,body{margin:0;padding:0;height:100%}
body{font-family:Lato,"Slack-Lato","Helvetica Neue",Helvetica,"Segoe UI",system-ui,Arial,sans-serif;font-size:15px;line-height:1.46668;color:var(--fg);background:var(--bg);-webkit-font-smoothing:antialiased;font-variant-ligatures:common-ligatures}
a{color:var(--link);text-decoration:none}
a:hover{text-decoration:underline}
button{font-family:inherit}
.sm-ic{flex:none;display:block}

.sm-app{display:flex;flex-direction:column;height:100vh;overflow:hidden;background:var(--t-menu);color:var(--t-fg);--t-dim:color-mix(in srgb,var(--t-fg) 72%,var(--t-col));--t-tint:color-mix(in srgb,var(--t-fg) 9%,transparent);--t-line:color-mix(in srgb,var(--t-fg) 11%,transparent)}
.sm-titlebar{height:40px;flex:none;display:flex;align-items:center;gap:8px;padding:0 8px 0 0;color:var(--t-dim)}
.sm-tb-left{width:330px;flex:none;display:flex;justify-content:flex-end;align-items:center;gap:4px;padding-right:8px}
.sm-tb-right{flex:1 1 0;display:flex;justify-content:flex-end;align-items:center;gap:4px}
.sm-tb-btn{width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;color:inherit;border:0;background:none;padding:0}
.sm-tb-off{opacity:.45}
a.sm-tb-btn:hover{background:var(--t-tint);text-decoration:none;color:var(--t-fg)}
.sm-search{flex:2 1 0;max-width:732px;height:28px;display:flex;align-items:center;gap:8px;padding:0 10px;border-radius:6px;background:var(--t-tint);font-size:13px;color:var(--t-dim);white-space:nowrap;overflow:hidden}
.sm-body{flex:1;min-height:0;display:flex}
.sm-rail{width:70px;flex:none;display:flex;flex-direction:column;align-items:center;gap:14px;padding:4px 0 16px}
.sm-team-icon{width:36px;height:36px;border-radius:8px;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--t-fg) 86%,var(--t-col));color:var(--t-col);font-weight:900;font-size:16px;margin-bottom:4px}
.sm-team-icon:hover{text-decoration:none}
.sm-tab{display:flex;flex-direction:column;align-items:center;gap:3px;font-size:11px;font-weight:700;line-height:13px;color:var(--t-dim)}
.sm-tab-ic{width:36px;height:36px;border-radius:8px;display:flex;align-items:center;justify-content:center}
.sm-tab-on{color:var(--t-fg)}
.sm-tab-on .sm-tab-ic{background:color-mix(in srgb,var(--t-fg) 14%,transparent)}
.sm-rail-end{margin-top:auto;display:flex;flex-direction:column;align-items:center;gap:14px}
.sm-rail-add{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--t-tint);color:var(--t-dim)}
.sm-workspace{flex:1;min-width:0;display:flex;margin:0 4px 4px 0;border-radius:6px;overflow:hidden;box-shadow:0 0 0 1px var(--t-line);background:var(--bg);color:var(--fg)}

.sm-side{width:260px;flex:none;background:var(--t-col);color:var(--t-dim);overflow-y:auto;border-right:1px solid var(--t-line);padding-bottom:16px}
.sm-side-title{height:49px;display:flex;align-items:center;gap:4px;padding:0 12px 0 16px;color:var(--t-fg);font-weight:900;font-size:18px;position:sticky;top:0;background:var(--t-col);z-index:1}
.sm-side-title a{color:inherit;min-width:0;display:flex;align-items:center;gap:2px;padding:2px 6px;margin-left:-6px;border-radius:6px}
.sm-side-title a span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sm-side-title a:hover{background:var(--t-menu);text-decoration:none}
.sm-side-tools{margin-left:auto;display:flex;gap:2px;color:var(--t-dim);flex:none}
.sm-side-tools span{width:32px;height:32px;display:flex;align-items:center;justify-content:center}
.sm-side-h{display:flex;align-items:center;gap:4px;height:28px;margin-top:14px;padding:0 16px 0 12px;font-size:15px}
.sm-row{display:flex;align-items:center;gap:8px;height:28px;margin:0 8px;padding:0 8px;border-radius:6px;color:inherit;font-size:15px;white-space:nowrap}
.sm-row-ic{width:20px;height:20px;flex:none;display:flex;align-items:center;justify-content:center;position:relative}
.sm-row-name{overflow:hidden;text-overflow:ellipsis}
a.sm-row:hover{background:var(--t-hover);text-decoration:none}
a.sm-row.sm-active,a.sm-row.sm-active:hover{background:var(--t-active);color:var(--t-active-fg)}
.sm-row-av{width:20px;height:20px;border-radius:4px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:9px;font-weight:700;overflow:hidden}
.sm-row-av img{width:100%;height:100%;object-fit:cover}
.sm-presence{position:absolute;right:-3px;bottom:-3px;width:9px;height:9px;border-radius:50%;background:var(--t-presence);box-shadow:0 0 0 2px var(--t-col)}
.sm-active .sm-presence{box-shadow:0 0 0 2px var(--t-active)}

.sm-main{flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden;background:var(--bg)}
.sm-shot{width:760px;background:var(--bg)}
.sm-top{height:49px;flex:none;display:flex;align-items:center;gap:8px;padding:0 16px 0 20px;box-shadow:0 1px 0 var(--line);z-index:1}
.sm-top h1{font-size:18px;font-weight:900;line-height:24px;margin:0;display:flex;align-items:center;gap:3px;white-space:nowrap;min-width:0}
.sm-top h1 .sm-caret{color:var(--fg2)}
.sm-top .sm-sub{font-size:13px;color:var(--fg2);min-width:0;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-left:4px}
.sm-back{position:absolute;left:-9999px;font-size:13px;font-weight:700;color:var(--fg2)}
.sm-back:focus{position:static}
.sm-top-actions{margin-left:auto;display:flex;gap:8px;align-items:center;flex:none;color:var(--fg2)}
.sm-top-actions a{font-size:13px;font-weight:700;color:var(--fg2)}
.sm-top-actions a:hover{color:var(--fg);text-decoration:none}
.sm-top-pill{height:28px;display:flex;align-items:center;gap:6px;padding:0 8px 0 4px;border:1px solid var(--line);border-radius:8px;font-size:13px;font-weight:700;color:var(--fg2)}
.sm-top-pill .sm-ic:first-child{margin-left:4px}
.sm-faces{display:flex}
.sm-faces .sm-face{margin-left:-4px;box-shadow:0 0 0 2px var(--bg)}
.sm-faces .sm-face:first-child{margin-left:0}
.sm-face{width:20px;height:20px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:9px;font-weight:700;overflow:hidden;flex:none}
.sm-face img{width:100%;height:100%;object-fit:cover}
.sm-top-ic{width:28px;height:28px;display:flex;align-items:center;justify-content:center}
.sm-tabs{height:38px;flex:none;overflow:hidden;white-space:nowrap;display:flex;align-items:stretch;gap:4px;padding:0 16px;box-shadow:0 1px 0 var(--line);font-size:13px;color:var(--fg2);z-index:1}
.sm-tabs span{display:flex;align-items:center;gap:6px;padding:0 8px;border-bottom:2px solid transparent;margin-top:2px}
.sm-tabs .sm-tabs-on{color:var(--fg);font-weight:700;border-bottom-color:var(--accent)}
.sm-page{padding:16px 0 4px}
.sm-main .sm-page{flex:1;overflow-y:auto;display:flex;flex-direction:column}
.sm-main .sm-page>*{flex:none}
.sm-main .sm-page>.sm-daydiv:first-child,.sm-main .sm-page>.sm-msg:first-child{margin-top:auto}
.sm-admin{padding:4px 20px 24px}
.sm-shot .sm-page{padding:12px 0 16px}

.sm-panel{width:var(--sm-panel-w,50%);min-width:360px;flex:0 1 auto;display:flex;flex-direction:column;border-left:1px solid var(--line);background:var(--bg);overflow:hidden}
.sm-panel-top{height:49px;display:flex;align-items:center;gap:4px;padding:0 12px 0 16px;box-shadow:0 1px 0 var(--line);flex:none;z-index:1}
.sm-panel-heading{flex:1;min-width:0;display:flex;align-items:baseline;gap:8px;white-space:nowrap}
.sm-panel-title{font-size:18px;font-weight:900;margin:0;line-height:24px}
.sm-panel-sub{font-size:13px;color:var(--fg2);overflow:hidden;text-overflow:ellipsis}
.sm-panel-close,.sm-panel-expand{width:36px;height:36px;color:var(--fg2);border-radius:8px;flex:none}
.sm-panel-close:hover,.sm-panel-expand:hover{background:var(--hover);color:var(--fg);text-decoration:none}
.sm-panel-back{display:none;color:var(--fg2);flex:none}
${glyphIcon(".sm-panel-close", "close")}
${glyphIcon(".sm-panel-expand", "popout", 18)}
.sm-panel-body{flex:1;overflow-y:auto;padding:8px 0 4px}
.sm-resize{width:5px;margin:0 -2px;flex:none;cursor:col-resize;position:relative;z-index:2}
.sm-resize:hover,.sm-resize.sm-dragging{background:var(--link)}
.sm-icon-btn{display:inline-flex;align-items:center;justify-content:center;font-size:16px;line-height:22px;color:var(--fg2);padding:0 6px;border-radius:6px;cursor:pointer}
.sm-icon-btn:hover{background:var(--hover);color:var(--fg);text-decoration:none}
a.sm-icon-btn{width:36px;height:36px;border-radius:8px;padding:0}
${glyphIcon("a.sm-icon-btn", "popout", 18)}

.sm-composer{position:relative;flex:none;padding:0 20px 20px;background:var(--bg)}
.sm-panel .sm-composer{padding:0 16px 16px}
.sm-composer-box{border:1px solid var(--line2);border-radius:8px;background:var(--bg);overflow:hidden}
.sm-composer-box:focus-within{border-color:var(--fg3);box-shadow:0 0 0 1px var(--fg3)}
.sm-composer-fmt{display:flex;align-items:center;gap:2px;height:38px;overflow:hidden;padding:0 6px;background:var(--hover);color:var(--fg3)}
.sm-composer-box:focus-within .sm-composer-fmt{color:var(--fg2)}
.sm-composer-fmt span,.sm-composer-tools span{width:28px;height:28px;display:flex;align-items:center;justify-content:center;border-radius:4px}
.sm-composer-fmt i,.sm-composer-tools i{width:1px;height:20px;background:var(--line);margin:0 4px}
.sm-composer-also{display:flex;align-items:center;gap:8px;padding:2px 12px 6px;font-size:13px;color:var(--fg2)}
.sm-composer-also i{width:16px;height:16px;border:1px solid var(--line2);border-radius:3px}
.sm-composer-row{display:flex;align-items:center;gap:8px;height:40px;padding:0 6px}
.sm-composer-tools{display:flex;align-items:center;gap:2px;color:var(--fg2);min-width:0;overflow:hidden}
.sm-composer-fmt>*,.sm-composer-tools>*{flex:none}
.sm-composer-tools .sm-tool-plus{border-radius:50%;background:var(--inset)}
.sm-composer-text{display:block;width:100%;border:0;outline:none;resize:none;field-sizing:content;min-height:38px;max-height:40vh;font-family:inherit;font-size:15px;line-height:22px;color:var(--fg);padding:8px 12px;background:none}
.sm-composer-text::placeholder{color:var(--fg3);opacity:1}
.sm-composer-send{flex:none;margin-left:auto;display:flex;align-items:center;justify-content:center;width:32px;height:28px;border:0;border-radius:4px 0 0 4px;background:var(--green);color:#fff;padding:0;cursor:pointer}
.sm-composer-send:hover{background:var(--green-hover)}
.sm-composer-send-more{width:22px;height:28px;display:flex;align-items:center;justify-content:center;border-radius:0 4px 4px 0;background:var(--green);color:#fff;margin-left:-7px;box-shadow:inset 1px 0 0 rgba(255,255,255,.3)}
.sm-composer-box:has(.sm-composer-text:placeholder-shown) .sm-composer-send,.sm-composer-box:has(.sm-composer-text:placeholder-shown) .sm-composer-send-more{background:none;color:var(--fg3);box-shadow:none}
.sm-composer-box:has(.sm-composer-text:placeholder-shown) .sm-composer-send-more{box-shadow:inset 1px 0 0 var(--line)}
.sm-composer-hint{position:absolute;right:20px;bottom:3px;font-size:11px;line-height:14px;color:var(--fg2);visibility:hidden}
.sm-panel .sm-composer-hint{right:16px}
.sm-composer:focus-within .sm-composer-hint,.sm-composer[data-gated] .sm-composer-hint{visibility:visible}
.sm-mentions{display:none;position:absolute;left:20px;right:20px;bottom:100%;margin-bottom:6px;max-height:260px;overflow-y:auto;background:var(--raised);border-radius:8px;box-shadow:var(--pop);z-index:5;padding:6px 0}
.sm-panel .sm-mentions{left:16px;right:16px}
.sm-mention{display:flex;align-items:center;gap:8px;padding:4px 16px;font-size:15px;cursor:pointer;color:var(--fg)}
.sm-mention-on{background:var(--link);color:#fff}
.sm-mention-on .sm-mention-real{color:rgba(255,255,255,.8)}
.sm-mention-av{width:20px;height:20px;border-radius:4px;flex:none;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:9px;font-weight:700;overflow:hidden}
.sm-mention-av img{width:100%;height:100%;object-fit:cover}
.sm-mention-name{font-weight:700}
.sm-mention-real{color:var(--fg2);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.sm-row,.sm-btn,.sm-select,.sm-reaction,button.sm-reaction-more,.sm-file-card,.sm-prompt,.sm-replies,.sm-back,.sm-panel-close,.sm-panel-expand,.sm-theme-toggle,.sm-top-actions a{cursor:pointer}
.sm-composer-text{cursor:text}
.sm-badge,.sm-time,.sm-daydiv,.sm-pill,.sm-emoji-name,.sm-avatar,.sm-name,.sm-composer-hint,.sm-unsupported,.sm-tag,.sm-card,.sm-side-h,span.sm-row,.sm-tab,.sm-search{cursor:default}
a.sm-pill,.sm-chip{cursor:pointer}
.sm-identity{position:relative}
.sm-identity[hidden]{display:none}
.sm-identity summary{display:flex;align-items:center;gap:6px;list-style:none;cursor:pointer;position:relative;border-radius:8px}
.sm-identity summary::-webkit-details-marker{display:none}
.sm-identity-avatar{width:24px;height:24px;border-radius:5px;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:10px;font-weight:700;flex:none;overflow:hidden}
.sm-identity-avatar img{width:100%;height:100%;object-fit:cover}
.sm-rail .sm-identity summary .sm-identity-avatar{width:36px;height:36px;border-radius:8px;font-size:14px}
.sm-rail .sm-identity summary:after{content:"";position:absolute;right:-3px;bottom:-3px;width:10px;height:10px;border-radius:50%;background:var(--t-presence);box-shadow:0 0 0 3px var(--t-menu)}
.sm-rail .sm-identity-name{position:absolute;left:-9999px}
.sm-identity-list{position:absolute;right:0;top:100%;z-index:10;width:max-content;min-width:220px;max-width:300px;margin:6px 0 0;padding:6px 0;list-style:none;background:var(--raised);color:var(--fg);border-radius:8px;box-shadow:var(--pop)}
.sm-rail .sm-identity-list{left:calc(100% + 10px);right:auto;top:auto;bottom:0;margin:0}
.sm-identity-list button{display:flex;align-items:center;gap:8px;width:100%;border:0;padding:5px 16px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.sm-identity-list button:hover,.sm-identity-list button:focus{background:var(--link);color:#fff;outline:none}
.sm-identity-list button:hover span,.sm-identity-list button:focus span{color:inherit}
.sm-identity-list [aria-current] > span:nth-child(2){font-weight:700}
.sm-identity-user{font-size:13px;color:var(--fg2);margin-left:auto;padding-left:12px}
.sm-user-status{margin-left:6px;font-size:13px;font-weight:400;color:var(--fg2)}
.sm-mobile-bar{display:none}

.sm-daydiv{position:relative;display:flex;justify-content:center;margin:4px 0 8px}
.sm-daydiv:before{content:"";position:absolute;left:0;right:0;top:50%;height:1px;background:var(--line)}
.sm-daydiv span{position:relative;display:inline-flex;align-items:center;gap:4px;height:28px;border:1px solid var(--line);border-radius:24px;padding:0 12px 0 16px;font-size:13px;font-weight:700;line-height:27px;color:var(--fg);background:var(--bg)}
.sm-replies-div{display:flex;align-items:center;gap:12px;padding:4px 16px 4px 20px;font-size:13px;color:var(--fg2)}
.sm-replies-div:after{content:"";flex:1;height:1px;background:var(--line)}

.sm-msg{position:relative;display:flex;gap:8px;padding:8px 20px}
.sm-msg-cont{padding-top:4px;padding-bottom:4px}
.sm-msg:hover{background:var(--hover)}
.sm-msg-eph{background:var(--inset)}
.sm-msg-open{background:var(--hover)}
.sm-avatar{width:36px;height:36px;flex:none;border-radius:5px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:14px;overflow:hidden;margin-top:3px}
.sm-avatar img{width:36px;height:36px;object-fit:cover}
.sm-avatar-emoji{font-size:22px;background:var(--inset)}
.sm-gutter{width:36px;flex:none;font-size:12px;line-height:22px;text-align:right;color:var(--fg2);visibility:hidden;white-space:nowrap}
.sm-msg:hover .sm-gutter{visibility:visible}
.sm-msg-body{min-width:0;flex:1}
.sm-msg-head{display:flex;align-items:baseline;flex-wrap:wrap;line-height:22px}
.sm-name{font-weight:900;font-size:15px;color:var(--fg)}
.sm-badge{align-self:center;margin-left:4px;background:color-mix(in srgb,var(--fg) 13%,transparent);color:var(--fg2);font-size:10px;font-weight:700;line-height:12px;border-radius:2px;padding:1px 3px;letter-spacing:.2px;text-transform:uppercase}
.sm-time{font-size:12px;color:var(--fg2);margin-left:8px}
.sm-text{font-size:15px;line-height:22px;word-wrap:break-word;overflow-wrap:anywhere}
.sm-edited{font-size:13px;color:var(--fg2)}
.sm-eph-note{display:flex;align-items:center;gap:4px;font-size:13px;color:var(--fg2)}
.sm-stream{display:inline-block;margin-left:6px;color:var(--fg2);font-weight:700;animation:sm-pulse 1s ease-in-out infinite}
@keyframes sm-pulse{0%,100%{opacity:.25}50%{opacity:1}}
@keyframes sm-appear{0%{opacity:0}100%{opacity:1}}
.sm-msg-new{animation:sm-appear .25s ease-out}
@media (prefers-reduced-motion:reduce){.sm-msg-new,.sm-stream{animation:none}}
.sm-live{display:none;font-size:12px;font-weight:700;color:var(--warn-fg);margin-left:10px;white-space:nowrap}
.sm-live-off{display:inline}
.sm-composer-lock{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 0 14px;font-size:13px;color:var(--fg2)}
.sm-composer-lock[hidden]{display:none}
.sm-composer-lock input{font:inherit;font-size:13px;padding:5px 8px;border:1px solid var(--line2);border-radius:4px;width:130px;background:var(--bg);color:var(--fg)}
.sm-composer-lock .sm-lock-go{font:inherit;font-size:13px;font-weight:700;padding:5px 12px;border:1px solid var(--green);border-radius:4px;background:var(--green);color:#fff;cursor:pointer}
.sm-composer-lock .sm-err{color:var(--red)}
.sm-composer-text:disabled{color:var(--fg3)}

.sm-pill{background:var(--pill-bg);color:var(--pill-fg);border-radius:3px;padding:0 2px 1px}
.sm-link{color:var(--link)}
.sm-chip{padding:1px 6px 2px;border-radius:6px;white-space:nowrap;font-weight:700;font-size:.9334em;-webkit-box-decoration-break:clone;box-decoration-break:clone;transition:background .12s}
.sm-chip:hover{text-decoration:none}
.sm-chip .sm-ic{display:inline-block;vertical-align:-2px;margin-right:4px}
a.sm-link.sm-chip{background:var(--chip-bg);color:var(--link)}
a.sm-link.sm-chip:hover{background:var(--chip-hover)}
a.sm-link.sm-chip>.sm-ic{color:var(--fg2)}
.sm-chip-user{padding-left:3px}
.sm-chip-av{display:inline-flex;vertical-align:-3px;margin-right:4px;width:16px;height:16px;border-radius:4px;align-items:center;justify-content:center;color:#fff;font-size:8px;font-weight:700;line-height:1;overflow:hidden}
.sm-chip-av img{width:100%;height:100%;object-fit:cover}
a.sm-chip-channel:hover{background:var(--pill-hover)}
.sm-chip-channel .sm-ic{margin-right:1px}
.sm-chip-state{margin-left:4px}
.sm-chip-state .sm-ic{margin-right:0}
.sm-chip-open{color:#1a7f37}
.sm-chip-merged{color:#8250df}
.sm-chip-closed{color:#cf222e}
.sm-chip-draft{color:var(--fg3)}
:root[data-theme=dark] .sm-chip-open{color:#3fb950}
:root[data-theme=dark] .sm-chip-merged{color:#a371f7}
:root[data-theme=dark] .sm-chip-closed{color:#f85149}
.sm-emoji-name{color:var(--fg2)}
.sm-code{font-family:${MONO};font-size:12px;font-variant-ligatures:none;background:var(--inset);border:1px solid var(--line);border-radius:3px;padding:2px 3px 1px;color:var(--code);white-space:pre-wrap}
.sm-pre{font-family:${MONO};font-size:12px;line-height:1.50001;font-variant-ligatures:none;background:var(--inset);border:1px solid var(--line);border-radius:4px;padding:8px;margin:4px 0;white-space:pre-wrap;word-break:break-word;color:var(--fg)}
.sm-quote{position:relative;margin:4px 0;padding:0 0 0 16px;color:var(--fg)}
.sm-quote:before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;border-radius:8px;background:var(--line2);opacity:.6}
.sm-list{margin:2px 0;padding-left:26px}
.sm-list li{margin:0;padding-left:2px}

.sm-blocks{margin:0}
.sm-block{margin:0 0 8px;max-width:600px}
.sm-rich-text,.sm-markdown,.sm-table-block{max-width:none}
.sm-blocks>.sm-block:last-child{margin-bottom:0}
.sm-header-block{font-size:18px;font-weight:900;line-height:1.33334;margin:4px 0}
.sm-section-split{display:flex;gap:12px;align-items:flex-start}
.sm-section-main{flex:1;min-width:0}
.sm-section-acc{flex:none}
.sm-fields{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:6px}
.sm-field{flex:1 1 40%;min-width:0}
.sm-field-wide{flex-basis:100%}
.sm-field-title{font-weight:700}
.sm-context{display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px;font-size:13px;line-height:1.38463;color:var(--fg2)}
.sm-context .sm-pre,.sm-context .sm-code{font-size:11px}
.sm-context-img{width:20px;height:20px;border-radius:3px;object-fit:cover}
.sm-hr{border:0;border-top:1px solid var(--line);margin:12px 0}
.sm-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.sm-context-actions{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.sm-feedback{display:inline-flex;gap:4px}
.sm-btn{display:inline-flex;align-items:center;height:28px;border:1px solid var(--line2);border-radius:6px;padding:0 12px;font-size:13px;font-weight:700;color:var(--fg);background:var(--bg);white-space:nowrap}
.sm-btn:hover{text-decoration:none;background:var(--hover);color:var(--fg);box-shadow:0 1px 3px rgba(0,0,0,.08)}
.sm-btn-primary{background:var(--green);border-color:var(--green);color:#fff}
.sm-btn-primary:hover{background:var(--green-hover);border-color:var(--green-hover);color:#fff}
.sm-btn-danger,.sm-btn-danger:hover{color:var(--red)}
.sm-btn-confirm{margin-left:6px;opacity:.7;font-weight:400}
.sm-btn.sm-icon-btn{padding:0 8px;font-weight:400;font-size:14px;border-color:var(--line)}
.sm-select{display:inline-flex;align-items:center;justify-content:space-between;gap:8px;height:28px;min-width:120px;border:1px solid var(--line2);border-radius:6px;padding:0 8px 0 12px;font-size:13px;color:var(--fg);background:var(--bg)}
.sm-select-caret{color:var(--fg2);font-size:11px}
.sm-overflow{min-width:0;padding:0 8px;font-weight:700}
.sm-options{display:flex;flex-direction:column;gap:4px}
.sm-acc-img{width:88px;height:88px;object-fit:cover;border-radius:8px;display:block}
.sm-img{max-width:min(100%,360px);border-radius:8px;display:block;margin-top:4px}
.sm-img-title{font-size:13px;color:var(--fg2)}
.sm-label{font-weight:700;margin-bottom:4px}
.sm-hint{font-size:13px;color:var(--fg2);margin-top:4px}
.sm-input{border:1px solid var(--line2);border-radius:8px;padding:6px 12px;min-height:36px;background:var(--bg)}
.sm-input-multi{min-height:76px}
.sm-input-ph{color:var(--fg3)}
.sm-file-block{color:var(--fg2)}
.sm-video-thumb{max-width:360px;border-radius:8px;display:block}
.sm-video-title{font-weight:700;margin-top:4px}
.sm-unsupported{display:inline-block;background:var(--inset);border:1px solid var(--line);border-radius:4px;padding:4px 8px;font-size:12px;color:var(--fg2);font-family:${MONO}}
.sm-rt-section{margin:0}
.sm-table-caption{font-size:13px;font-weight:700;color:var(--fg2);margin-bottom:4px}
.sm-table-wrap{width:fit-content;overflow-x:auto;border:1px solid var(--line);border-radius:8px;max-width:100%}
.sm-bk-table{border-collapse:collapse;font-size:14px;line-height:20px}
.sm-bk-table th,.sm-bk-table td{padding:6px 12px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap;vertical-align:top}
.sm-bk-table th{font-weight:700;background:var(--hover)}
.sm-bk-table tr:last-child td{border-bottom:0}
.sm-bk-table .sm-ta-center{text-align:center}
.sm-bk-table .sm-ta-right{text-align:right}
.sm-bk-table .sm-td-wrap{white-space:normal}
.sm-table-pager{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--fg2);margin-top:4px}
.sm-pager-btn{border:1px solid var(--line);border-radius:4px;background:var(--bg);color:var(--fg);font-size:14px;line-height:16px;padding:0 6px;cursor:pointer}
.sm-pager-btn:disabled{color:var(--fg3);cursor:default}
.sm-chart{border:1px solid var(--line);border-radius:8px;padding:10px 12px;max-width:520px}
.sm-chart-title{font-size:14px;font-weight:700;margin-bottom:6px}
.sm-chart-svg{display:block;max-width:100%;height:auto;font-size:11px;fill:var(--fg2)}
.sm-chart-svg line{stroke:var(--line)}
.sm-chart-axis{font-size:11px;color:var(--fg2)}
.sm-chart-axis-x{text-align:center}
.sm-chart-legend{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;color:var(--fg2);margin-top:6px}
.sm-chart-key i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px}

.sm-atts{margin-top:4px}
.sm-att{position:relative;border-left:4px solid var(--line2);border-radius:4px;padding:0 0 0 12px;margin:4px 0;max-width:520px}
.sm-att-pretext{margin-top:4px}
.sm-att-author{display:flex;align-items:center;gap:8px;font-weight:700}
.sm-att-author-icon{width:16px;height:16px;border-radius:2px}
.sm-att-title{font-weight:700}
.sm-att-img{max-width:360px;border-radius:8px;display:block;margin-top:8px}
.sm-att-thumb{max-width:80px;border-radius:4px;display:block;margin-top:6px}
.sm-att-footer{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--fg2);margin-top:4px}
.sm-att-footer-icon{width:16px;height:16px;border-radius:2px}

.sm-files{margin-top:8px;display:flex;flex-direction:column;gap:8px;align-items:flex-start}
.sm-file-img{max-width:min(100%,360px);max-height:360px;border-radius:8px;box-shadow:0 0 0 1px var(--line);display:block}
.sm-file-card{display:flex;gap:12px;align-items:center;border:1px solid var(--line);border-radius:12px;padding:12px;width:min(100%,426px);background:var(--bg)}
.sm-file-icon{width:36px;height:36px;border-radius:8px;display:flex;align-items:center;justify-content:center;background:#1d9bd1;color:#fff;flex:none}
.sm-file-name{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sm-file-name a{color:var(--fg)}
.sm-file-meta{font-size:13px;color:var(--fg2)}
.sm-file-card:hover{box-shadow:0 1px 3px rgba(0,0,0,.08)}

.sm-reactions{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;padding-bottom:2px}
.sm-reaction,.sm-reaction-more{display:inline-flex;align-items:center;gap:4px;height:24px;background:var(--react);border:1px solid transparent;border-radius:12px;padding:0 8px 0 6px;font:inherit;font-size:16px;line-height:16px;color:var(--fg)}
button.sm-reaction:hover,button.sm-reaction-more:hover{background:var(--bg);border-color:var(--fg3)}
.sm-reaction[aria-pressed="true"]{background:var(--pill-bg);border-color:var(--link);box-shadow:inset 0 0 0 .5px var(--link)}
.sm-reaction[aria-pressed="true"] .sm-reaction-count{color:var(--link)}
.sm-reaction:disabled{cursor:default}
.sm-reaction-count{font-weight:700;font-size:12px;font-variant-numeric:tabular-nums}
.sm-reaction-more{padding:0 8px;color:var(--fg2)}
.sm-message-actions{position:absolute;right:17px;top:-16px;display:flex;gap:0;padding:2px;background:var(--raised);border-radius:8px;box-shadow:var(--float);opacity:0;pointer-events:none;z-index:2}
.sm-msg:hover .sm-message-actions,.sm-msg:focus-within .sm-message-actions{opacity:1;pointer-events:auto}
.sm-message-actions button,.sm-message-actions a,.sm-message-actions span{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:0;border-radius:6px;background:none;color:var(--fg2);font:inherit;font-size:16px;cursor:pointer;text-decoration:none}
.sm-message-actions button:hover,.sm-message-actions a:hover{background:var(--hover);color:var(--fg)}
.sm-message-actions button:disabled{opacity:.5;cursor:default}
.sm-message-actions span{cursor:default}
.sm-message-actions svg{width:18px;height:18px;flex:none}
.sm-action-error{font-size:13px;color:var(--red);margin-top:6px}
.sm-reaction-picker{position:fixed;inset:auto;top:0;left:0;margin:0;z-index:100;width:300px;max-width:calc(100vw - 24px);max-height:calc(var(--sm-viewport-height,100dvh) - 24px);padding:16px;border:0;border-radius:12px;background:var(--raised);color:var(--fg);box-shadow:var(--pop)}
.sm-reaction-picker-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
.sm-reaction-picker h2{font-size:15px;font-weight:900;margin:0}
.sm-reaction-picker button{min-width:40px;min-height:40px;border:0;border-radius:6px;background:none;color:inherit;font:inherit;cursor:pointer}
.sm-reaction-picker button:hover,.sm-reaction-picker button:focus-visible{background:var(--hover)}
.sm-reaction-picker button:disabled{opacity:.5;cursor:default}
.sm-reaction-choices{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.sm-reaction-choices button{font-size:24px}

.sm-replies{display:flex;align-items:center;gap:8px;width:fit-content;min-width:min(100%,360px);max-width:600px;height:36px;margin:4px 0 0 -5px;padding:0 8px 0 5px;border:1px solid transparent;border-radius:8px;font-size:13px;color:var(--link)}
.sm-replies:hover{background:var(--bg);border-color:var(--line);text-decoration:none}
.sm-replies .sm-face{width:24px;height:24px;border-radius:5px;font-size:10px}
.sm-replies-faces{display:flex;gap:4px}
.sm-replies-count{font-weight:700}
.sm-replies:hover .sm-replies-count{text-decoration:underline}
.sm-replies-time{color:var(--fg2)}
.sm-replies-view{display:none;color:var(--fg2)}
.sm-replies-go{margin-left:auto;color:var(--fg2);visibility:hidden}
.sm-replies:hover .sm-replies-time{display:none}
.sm-replies:hover .sm-replies-view{display:inline}
.sm-replies:hover .sm-replies-go{visibility:visible}
.sm-empty{color:var(--fg2);padding:16px 20px}

.sm-assist{border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin:4px 20px 12px;background:var(--hover)}
.sm-assist-title{font-weight:900}
.sm-assist-status{font-size:13px;color:var(--fg2);margin-top:2px}
.sm-assist-status .sm-stream{margin-left:2px}
.sm-prompts{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.sm-prompt{border:1px solid var(--line2);border-radius:8px;padding:5px 12px;font-size:13px;font-weight:700;background:var(--bg)}

.sm-cards{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:16px}
.sm-card{border:1px solid var(--line);border-radius:8px;padding:10px 14px;min-width:150px}
.sm-card-k{font-size:12px;color:var(--fg2);text-transform:uppercase;letter-spacing:.4px}
.sm-card-v{font-size:16px;font-weight:700;margin-top:2px}
.sm-h2{font-size:15px;font-weight:900;margin:18px 0 6px}
.sm-table{border-collapse:collapse;width:100%;max-width:900px;font-size:14px}
.sm-table th{text-align:left;font-size:12px;color:var(--fg2);font-weight:700;text-transform:uppercase;letter-spacing:.4px;padding:4px 10px 4px 0;border-bottom:1px solid var(--line)}
.sm-table td{padding:6px 10px 6px 0;border-bottom:1px solid var(--line);vertical-align:top}
.sm-tag{display:inline-block;background:var(--inset);color:var(--fg2);border-radius:10px;padding:0 8px;font-size:11px;font-weight:700}
.sm-muted{color:var(--fg2)}

@media (min-width:700px) and (max-width:1000px){
  .sm-side{width:190px}
  .sm-tb-left{width:260px}
  .sm-panel{min-width:300px;max-width:calc(100% - 360px)}
  .sm-top{padding:0 12px}
  .sm-top h1{overflow:hidden}
  .sm-top .sm-sub,.sm-top-pill,.sm-top-ic{display:none}
  .sm-replies{min-width:0}
  .sm-att-img,.sm-file-img,.sm-video-thumb,.sm-file-card{max-width:100%}
  .sm-chip{white-space:normal}
}
@media (max-width:699px),(hover:none),(pointer:coarse){
  .sm-message-actions{position:static;opacity:1;pointer-events:auto;justify-content:flex-start;gap:6px;margin-top:6px;padding:0;box-shadow:none;background:none}
  .sm-message-actions button,.sm-message-actions a{width:40px;height:40px}
  .sm-message-actions .sm-quick,.sm-message-actions span{display:none}
  .sm-gutter{visibility:visible}
}
@media (max-width:699px){
  html,body{overflow:hidden;overscroll-behavior:none}
  body{overflow-wrap:anywhere}
  .sm-app{position:fixed;top:var(--sm-viewport-top,0px);left:0;width:100%;height:100dvh;height:var(--sm-viewport-height,100dvh);background:var(--bg);color:var(--fg)}
  .sm-titlebar,.sm-rail,.sm-side,.sm-resize,.sm-tabs,.sm-top-pill,.sm-top-ic,.sm-composer-fmt,.sm-composer-also,.sm-composer-tools,.sm-composer-send-more{display:none}
  .sm-body{flex-direction:column}
  .sm-workspace{margin:0;border-radius:0;box-shadow:none;flex-direction:column;min-height:0}
  .sm-mobile-bar{display:block;flex:none;background:var(--t-col);color:var(--t-fg);border-bottom:1px solid var(--t-line);padding:calc(8px + env(safe-area-inset-top)) 12px 8px;z-index:10}
  .sm-mobile-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
  .sm-mobile-workspace{display:flex;align-items:center;min-height:40px;min-width:0;color:var(--t-fg);font-size:18px;font-weight:900}
  .sm-mobile-bar .sm-identity{flex:none;max-width:55%;color:var(--fg)}
  .sm-identity summary{min-height:40px;padding:0 10px 0 6px;background:var(--bg);border:1px solid var(--t-line);border-radius:20px;font-size:13px;font-weight:700}
  .sm-identity-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sm-identity-list{width:280px;max-width:calc(100vw - 24px);max-height:calc(var(--sm-viewport-height,100dvh) - 120px);overflow-y:auto}
  .sm-identity-list button{min-height:40px}
  .sm-identity-list button>span{min-width:0;overflow-wrap:anywhere}
  .sm-identity-user{white-space:normal}
  .sm-channel-switch{display:block;width:100%;min-height:40px;margin-top:6px;padding:6px 10px;border:1px solid var(--t-line);border-radius:8px;background:var(--t-menu);color:var(--t-fg);font:inherit;font-size:16px}
  .sm-main{min-height:0}
  .sm-app-thread .sm-main{display:none}
  .sm-panel{width:100%;min-width:0;min-height:0;flex:1;border-left:0}
  .sm-top{height:auto;min-height:44px;padding:4px 12px;gap:10px}
  .sm-top h1{font-size:16px;min-width:0;white-space:normal}
  .sm-top .sm-sub{display:none}
  .sm-back{position:static}
  .sm-panel-top{height:auto;min-height:44px;padding:4px 12px}
  .sm-panel-back{display:inline-flex;align-items:center;justify-content:center;width:40px;min-height:40px;padding:0;border:0;font-size:22px}
  .sm-panel-close,.sm-panel-expand{display:none}
  .sm-main .sm-page,.sm-panel-body{min-height:0;padding:8px 0 12px;overscroll-behavior:contain}
  .sm-msg{padding-left:12px;padding-right:12px}
  .sm-admin,.sm-empty{padding-left:12px;padding-right:12px}
  .sm-assist{margin-left:12px;margin-right:12px}
  .sm-msg-body,.sm-card-v,.sm-field,.sm-att,.sm-context,.sm-file-card{overflow-wrap:anywhere}
  .sm-text,.sm-blocks,.sm-att{font-size:16px;line-height:24px}
  .sm-composer,.sm-panel .sm-composer{padding:8px 12px calc(10px + env(safe-area-inset-bottom))}
  .sm-composer-box{display:flex;align-items:flex-end}
  .sm-composer-row{height:38px;padding:0 6px 0 0}
  .sm-composer-text{font-size:16px;line-height:22px;max-height:30vh;flex:1}
  .sm-composer-send{width:40px;height:32px;border-radius:6px}
  .sm-composer-hint{display:none}
  .sm-composer[data-gated] .sm-composer-hint{display:block;position:static}
  .sm-composer-lock input{font-size:16px;min-height:40px;flex:1;min-width:0}
  .sm-composer-lock>span:first-child{width:100%}
  .sm-mentions,.sm-panel .sm-mentions{left:12px;right:12px;max-height:min(260px,40vh)}
  .sm-mention{min-height:40px}
  .sm-chip{white-space:normal}
  .sm-btn,.sm-select,.sm-reaction,.sm-reaction-more,.sm-prompt,.sm-replies,.sm-back,.sm-icon-btn,.sm-composer-lock .sm-lock-go,.sm-lock-out{min-height:40px;display:inline-flex;align-items:center}
  .sm-reaction,.sm-reaction-more{border-radius:20px;padding:0 12px}
  .sm-btn,.sm-select{max-width:100%;white-space:normal}
  .sm-replies{flex-wrap:wrap;gap:4px 8px;height:auto;min-width:0;border-color:transparent}
  .sm-section-split{flex-wrap:wrap}
  .sm-section-main{flex-basis:100%}
  .sm-section-acc,.sm-context>*{min-width:0;max-width:100%}
  .sm-att-img,.sm-file-img,.sm-video-thumb{max-width:100%;height:auto}
  .sm-file-card,.sm-unsupported{max-width:100%}
  .sm-file-card>div:last-child{min-width:0}
  .sm-cards{gap:10px}
  .sm-card{flex:1 1 calc(50% - 5px);min-width:0}
  .sm-table,.sm-table tbody{display:block;width:100%}
  .sm-table tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 14px;padding:12px 0;border-bottom:1px solid var(--line)}
  .sm-table tr:first-child{display:none}
  .sm-table td{display:block;padding:0;border:0;overflow-wrap:anywhere}
  .sm-table td:before{content:attr(data-label);display:block;font-size:11px;color:var(--fg2);text-transform:uppercase;letter-spacing:.4px}
  .sm-table td a{display:inline-flex;align-items:center;min-height:40px}
  .sm-shot{width:100%}
}
`;

const WEIGHTS = Object.keys(LATO);
const SHEETS = new Map<string | undefined, string>();

/**
 * The page stylesheet. With `fontBase` the three Lato files load from that URL prefix (the mock
 * server serves them); without it they are inlined, so a page saved to a file still has them.
 */
export function stylesheet(fontBase?: string): string {
  const cached = SHEETS.get(fontBase);
  if (cached) return cached;
  const faces = WEIGHTS.map((weight) => {
    const src = fontBase
      ? `url(${fontBase}/lato-${weight}.woff2)`
      : `url(data:font/woff2;base64,${LATO[weight]})`;
    return `@font-face{font-family:Lato;font-weight:${weight};font-style:normal;font-display:block;src:${src} format("woff2")}`;
  }).join("");
  const sheet = `${faces}${CSS}`;
  SHEETS.set(fontBase, sheet);
  return sheet;
}

/** `<link rel="preload">` for the served fonts, so a one-shot screenshot waits for them. */
export function fontPreloads(fontBase: string): string {
  return WEIGHTS.map(
    (weight) =>
      `<link rel="preload" as="font" type="font/woff2" crossorigin href="${fontBase}/lato-${weight}.woff2">`,
  ).join("");
}

/** The woff2 bytes of one weight ("400", "700", "900"), for the server's font route. */
export function fontFile(weight: string): Buffer | undefined {
  const data = LATO[weight];
  return data ? Buffer.from(data, "base64") : undefined;
}
