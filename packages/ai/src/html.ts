import sanitizeHtml from "sanitize-html";

/** Tags allowed in a product description shown in the storefront. No attributes at all. */
export const DESCRIPTION_TAGS = [
  "h2",
  "h3",
  "p",
  "ul",
  "ol",
  "li",
  "strong",
  "em",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "br",
] as const;

/**
 * Sanitizes model output before it is stored and rendered. The model's input contains
 * untrusted supplier HTML, so its output is treated as untrusted too: only structural tags
 * survive, every attribute (href, src, style, on*) is dropped, and script/style content is removed.
 */
export function sanitizeDescriptionHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [...DESCRIPTION_TAGS],
    allowedAttributes: {},
    disallowedTagsMode: "discard",
    nonTextTags: ["script", "style", "textarea", "noscript", "iframe", "object"],
  }).trim();
}

/** Plain text from supplier HTML, for the model's input. Collapses whitespace and caps length. */
export function htmlToText(html: string, maxChars = 15_000): string {
  const text = sanitizeHtml(html.replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)[^>]*>/gi, "$&\n"), {
    allowedTags: [],
    allowedAttributes: {},
    nonTextTags: ["script", "style", "textarea", "noscript", "iframe", "object"],
  })
    .replace(/&nbsp;|\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}
