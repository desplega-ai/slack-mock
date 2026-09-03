// Block Kit and legacy attachments -> HTML.
// Everything unknown degrades to a small gray "unsupported: <type>" box instead
// of throwing, because agents can post arbitrary blocks through slack-post.

import {
  displayName,
  emojiChar,
  emojiFromUnicode,
  escapeHtml,
  mrkdwnToHtml,
  plainTextToHtml,
  type RenderContext,
} from "./mrkdwn.ts";

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function safeUrl(url: string): string | undefined {
  return /^(https?:\/\/|\/)/i.test(url) ? escapeHtml(url) : undefined;
}

function unsupported(what: string): string {
  return `<div class="sm-unsupported">unsupported: ${escapeHtml(what || "unknown")}</div>`;
}

/** mrkdwn / plain_text text object (or a bare string). */
export function textObject(v: unknown, ctx: RenderContext): string {
  if (typeof v === "string") return plainTextToHtml(v);
  const o = rec(v);
  if (!o) return "";
  const text = str(o.text);
  return o.type === "mrkdwn" ? mrkdwnToHtml(text, ctx) : plainTextToHtml(text);
}

function plainOf(v: unknown): string {
  const o = rec(v);
  return plainTextToHtml(o ? str(o.text) : str(v));
}

function image(url: string, alt: string, cls: string): string {
  const src = safeUrl(url);
  if (!src) return unsupported("image url");
  return `<img class="${cls}" src="${src}" alt="${escapeHtml(alt)}">`;
}

function imageSrcOf(block: Rec): string {
  const direct = str(block.image_url);
  if (direct) return direct;
  const file = rec(block.slack_file);
  return file ? str(file.url) || str(file.url_private) : "";
}

// ------------------------------------------------------------------ elements

function button(el: Rec, ctx: RenderContext): string {
  const style = str(el.style);
  const cls = `sm-btn${style === "primary" ? " sm-btn-primary" : style === "danger" ? " sm-btn-danger" : ""}`;
  const label = textObject(el.text, ctx) || "Button";
  const url = safeUrl(str(el.url));
  const confirm = rec(el.confirm)
    ? '<span class="sm-btn-confirm" title="confirmation dialog">⚠</span>'
    : "";
  return url
    ? `<a class="${cls}" href="${url}" target="_blank" rel="noopener">${label}${confirm}</a>`
    : `<span class="${cls}">${label}${confirm}</span>`;
}

function selectPill(el: Rec, ctx: RenderContext, glyph = "▾"): string {
  const initial = rec(el.initial_option);
  const label =
    (initial && textObject(initial.text, ctx)) ||
    textObject(el.placeholder, ctx) ||
    plainTextToHtml(str(el.type).replace(/_/g, " "));
  return `<span class="sm-select">${label}<span class="sm-select-caret">${glyph}</span></span>`;
}

function inputBox(el: Rec, ctx: RenderContext): string {
  const multiline = el.multiline === true;
  const value = str(el.initial_value);
  const inner = value
    ? plainTextToHtml(value)
    : `<span class="sm-input-ph">${textObject(el.placeholder, ctx)}</span>`;
  return `<div class="sm-input${multiline ? " sm-input-multi" : ""}">${inner}</div>`;
}

/** Section accessories and action elements. */
export function renderElement(v: unknown, ctx: RenderContext): string {
  const el = rec(v);
  if (!el) return "";
  const type = str(el.type);
  switch (type) {
    case "button":
      return button(el, ctx);
    case "image":
      return image(imageSrcOf(el), str(el.alt_text), "sm-acc-img");
    case "overflow":
      return `<span class="sm-select sm-overflow">⋯</span>`;
    case "datepicker":
      return selectPill({ ...el, placeholder: el.placeholder ?? "Select a date" }, ctx, "📅");
    case "timepicker":
      return selectPill({ ...el, placeholder: el.placeholder ?? "Select a time" }, ctx, "🕐");
    case "plain_text_input":
      return inputBox(el, ctx);
    case "checkboxes":
    case "radio_buttons":
      return `<div class="sm-options">${arr(el.options)
        .map((o) => {
          const opt = rec(o);
          const mark = type === "checkboxes" ? "☐" : "◯";
          return `<div class="sm-option">${mark} ${opt ? textObject(opt.text, ctx) : ""}</div>`;
        })
        .join("")}</div>`;
    default:
      if (type.endsWith("_select") || type.startsWith("multi_")) return selectPill(el, ctx);
      return unsupported(type);
  }
}

// ---------------------------------------------------------------- rich text

function richStyle(html: string, style: Rec | undefined): string {
  if (!html || !style) return html;
  let out = html;
  if (style.code === true) out = `<code class="sm-code">${out}</code>`;
  if (style.bold === true) out = `<strong>${out}</strong>`;
  if (style.italic === true) out = `<em>${out}</em>`;
  if (style.strike === true) out = `<s>${out}</s>`;
  return out;
}

function richElement(v: unknown, ctx: RenderContext): string {
  const el = rec(v);
  if (!el) return "";
  const style = rec(el.style);
  switch (str(el.type)) {
    case "text":
      return richStyle(plainTextToHtml(str(el.text)).replace(/\n/g, "<br>"), style);
    case "link": {
      const url = safeUrl(str(el.url));
      const label = plainTextToHtml(str(el.text) || str(el.url));
      if (!url) return label;
      return richStyle(
        `<a class="sm-link" href="${url}" target="_blank" rel="noopener">${label}</a>`,
        style,
      );
    }
    case "user": {
      const user = ctx.users.get(str(el.user_id));
      return `<span class="sm-pill">@${escapeHtml(user ? displayName(user) : str(el.user_id))}</span>`;
    }
    case "usergroup":
      return `<span class="sm-pill">@${escapeHtml(str(el.usergroup_id))}</span>`;
    case "channel": {
      const channel = ctx.channels.get(str(el.channel_id));
      return `<span class="sm-pill">#${escapeHtml(channel ? channel.name : str(el.channel_id))}</span>`;
    }
    case "broadcast":
      return `<span class="sm-pill">@${escapeHtml(str(el.range) || "channel")}</span>`;
    case "emoji": {
      const char =
        emojiChar(str(el.name)) ?? (el.unicode ? emojiFromUnicode(str(el.unicode)) : undefined);
      return char ?? `<span class="sm-emoji-name">:${escapeHtml(str(el.name))}:</span>`;
    }
    case "date":
      return plainTextToHtml(str(el.fallback) || str(el.timestamp));
    case "color":
      return plainTextToHtml(str(el.value));
    default:
      return "";
  }
}

function richSection(v: unknown, ctx: RenderContext): string {
  const block = rec(v);
  if (!block) return "";
  const inner = arr(block.elements)
    .map((e) => richElement(e, ctx))
    .join("");
  switch (str(block.type)) {
    case "rich_text_section":
      return `<div class="sm-rt-section">${inner}</div>`;
    case "rich_text_quote":
      return `<blockquote class="sm-quote">${inner}</blockquote>`;
    case "rich_text_preformatted":
      return `<pre class="sm-pre">${inner}</pre>`;
    case "rich_text_list": {
      const tag = str(block.style) === "ordered" ? "ol" : "ul";
      const indent = Number(block.indent) || 0;
      const items = arr(block.elements)
        .map((item) => `<li>${richSection(item, ctx)}</li>`)
        .join("");
      const margin = indent ? ` style="margin-left:${indent * 18}px"` : "";
      return `<${tag} class="sm-list"${margin}>${items}</${tag}>`;
    }
    default:
      return inner;
  }
}

// ------------------------------------------------------------------- blocks

function sectionBlock(block: Rec, ctx: RenderContext): string {
  const parts: string[] = [];
  if (block.text) parts.push(`<div class="sm-section-text">${textObject(block.text, ctx)}</div>`);
  const fields = arr(block.fields);
  if (fields.length) {
    parts.push(
      `<div class="sm-fields">${fields
        .map((f) => `<div class="sm-field">${textObject(f, ctx)}</div>`)
        .join("")}</div>`,
    );
  }
  const accessory = block.accessory ? renderElement(block.accessory, ctx) : "";
  const body = parts.join("");
  if (!accessory) return `<div class="sm-block sm-section">${body}</div>`;
  return `<div class="sm-block sm-section sm-section-split"><div class="sm-section-main">${body}</div><div class="sm-section-acc">${accessory}</div></div>`;
}

function contextBlock(block: Rec, ctx: RenderContext): string {
  const inner = arr(block.elements)
    .map((e) => {
      const el = rec(e);
      if (!el) return "";
      if (str(el.type) === "image")
        return image(imageSrcOf(el), str(el.alt_text), "sm-context-img");
      return `<span class="sm-context-text">${textObject(el, ctx)}</span>`;
    })
    .join("");
  return `<div class="sm-block sm-context">${inner}</div>`;
}

function imageBlock(block: Rec, ctx: RenderContext): string {
  const title = block.title
    ? `<div class="sm-img-title">${textObject(block.title, ctx)}</div>`
    : "";
  const src = imageSrcOf(block);
  const alt = str(block.alt_text);
  if (!src) {
    const file = rec(block.slack_file);
    return `<div class="sm-block">${title}${unsupported(`image (file ${str(file?.id) || "?"})`)}</div>`;
  }
  return `<div class="sm-block sm-image">${title}${image(src, alt, "sm-img")}</div>`;
}

function inputBlock(block: Rec, ctx: RenderContext): string {
  const label = block.label ? `<div class="sm-label">${plainOf(block.label)}</div>` : "";
  const element = block.element ? renderElement(block.element, ctx) : "";
  const hint = block.hint ? `<div class="sm-hint">${plainOf(block.hint)}</div>` : "";
  return `<div class="sm-block sm-input-block">${label}${element}${hint}</div>`;
}

function videoBlock(block: Rec, ctx: RenderContext): string {
  const thumb = safeUrl(str(block.thumbnail_url));
  const url = safeUrl(str(block.title_url) || str(block.video_url));
  const title = textObject(block.title, ctx) || plainTextToHtml(str(block.alt_text));
  const inner = `${thumb ? `<img class="sm-video-thumb" src="${thumb}" alt="${escapeHtml(str(block.alt_text))}">` : ""}<div class="sm-video-title">▶ ${title}</div>`;
  return `<div class="sm-block sm-video">${url ? `<a class="sm-video-link" href="${url}" target="_blank" rel="noopener">${inner}</a>` : inner}</div>`;
}

function renderBlock(v: unknown, ctx: RenderContext): string {
  const block = rec(v);
  if (!block) return unsupported("block");
  switch (str(block.type)) {
    case "header":
      return `<div class="sm-block sm-header-block">${textObject(block.text, ctx)}</div>`;
    case "section":
      return sectionBlock(block, ctx);
    case "divider":
      return `<div class="sm-block"><hr class="sm-hr"></div>`;
    case "context":
      return contextBlock(block, ctx);
    case "actions":
      return `<div class="sm-block sm-actions">${arr(block.elements)
        .map((e) => renderElement(e, ctx))
        .join("")}</div>`;
    case "image":
      return imageBlock(block, ctx);
    case "rich_text":
      return `<div class="sm-block sm-rich-text">${arr(block.elements)
        .map((e) => richSection(e, ctx))
        .join("")}</div>`;
    case "input":
      return inputBlock(block, ctx);
    case "file":
      return `<div class="sm-block sm-file-block">📎 ${escapeHtml(str(block.external_id) || str(block.file_id) || "file")}</div>`;
    case "video":
      return videoBlock(block, ctx);
    default:
      return `<div class="sm-block">${unsupported(str(block.type))}</div>`;
  }
}

export function renderBlocks(blocks: unknown[], ctx: RenderContext): string {
  const list = arr(blocks);
  if (!list.length) return "";
  return `<div class="sm-blocks">${list.map((b) => renderBlock(b, ctx)).join("")}</div>`;
}

// --------------------------------------------------------------- attachments

const NAMED_COLORS: Record<string, string> = {
  good: "#2eb67d",
  warning: "#ecb22e",
  danger: "#e01e5a",
};

function barColor(v: unknown): string {
  const raw = str(v).trim();
  if (!raw) return "#dddddd";
  const named = NAMED_COLORS[raw.toLowerCase()];
  if (named) return named;
  const hex = raw.startsWith("#") ? raw : `#${raw}`;
  return /^#[0-9a-fA-F]{3,8}$/.test(hex) ? hex : "#dddddd";
}

function attachmentFields(fields: unknown[], ctx: RenderContext): string {
  if (!fields.length) return "";
  return `<div class="sm-fields">${fields
    .map((f) => {
      const field = rec(f);
      if (!field) return "";
      const wide = field.short === true ? "" : " sm-field-wide";
      return `<div class="sm-field${wide}"><div class="sm-field-title">${plainTextToHtml(str(field.title))}</div><div>${mrkdwnToHtml(str(field.value), ctx)}</div></div>`;
    })
    .join("")}</div>`;
}

function attachment(v: unknown, ctx: RenderContext): string {
  const att = rec(v);
  if (!att) return "";
  const parts: string[] = [];
  const author = str(att.author_name);
  if (author) {
    const icon = safeUrl(str(att.author_icon));
    parts.push(
      `<div class="sm-att-author">${icon ? `<img class="sm-att-author-icon" src="${icon}" alt="">` : ""}${plainTextToHtml(author)}</div>`,
    );
  }
  const title = str(att.title);
  if (title) {
    const link = safeUrl(str(att.title_link));
    const inner = plainTextToHtml(title);
    parts.push(
      `<div class="sm-att-title">${link ? `<a class="sm-link" href="${link}" target="_blank" rel="noopener">${inner}</a>` : inner}</div>`,
    );
  }
  const text = str(att.text) || (parts.length ? "" : str(att.fallback));
  if (text) parts.push(`<div class="sm-att-text">${mrkdwnToHtml(text, ctx)}</div>`);
  parts.push(attachmentFields(arr(att.fields), ctx));
  const img = safeUrl(str(att.image_url));
  if (img) parts.push(`<img class="sm-att-img" src="${img}" alt="">`);
  const thumb = !img ? safeUrl(str(att.thumb_url)) : undefined;
  if (thumb) parts.push(`<img class="sm-att-thumb" src="${thumb}" alt="">`);
  const blocks = arr(att.blocks);
  if (blocks.length) parts.push(renderBlocks(blocks, ctx));
  const footer = str(att.footer);
  const ts = att.ts ? formatAttachmentTs(att.ts) : "";
  if (footer || ts) {
    const icon = safeUrl(str(att.footer_icon));
    parts.push(
      `<div class="sm-att-footer">${icon ? `<img class="sm-att-footer-icon" src="${icon}" alt="">` : ""}${plainTextToHtml(footer)}${footer && ts ? " | " : ""}${escapeHtml(ts)}</div>`,
    );
  }
  const pretext = str(att.pretext);
  const box = `<div class="sm-att" style="border-left-color:${barColor(att.color)}">${parts.join("")}</div>`;
  return pretext ? `<div class="sm-att-pretext">${mrkdwnToHtml(pretext, ctx)}</div>${box}` : box;
}

function formatAttachmentTs(v: unknown): string {
  const secs = Number(v);
  if (!Number.isFinite(secs) || secs <= 0) return str(v);
  const d = new Date(secs * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function renderAttachments(attachments: unknown[], ctx: RenderContext): string {
  const list = arr(attachments);
  if (!list.length) return "";
  return `<div class="sm-atts">${list.map((a) => attachment(a, ctx)).join("")}</div>`;
}
