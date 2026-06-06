// Markdown formatting for the TUI streaming output.
// Applies inline formatting (bold, italic, code, links) and
// line-start formatting (headings, lists, blockquotes).

export const FMT_BOLD = "\x1b[1;33m"; // bold yellow — key points
export const FMT_ITALIC = "\x1b[36m"; // cyan — secondary emphasis
export const FMT_LINK = "\x1b[34;4m"; // blue underline — links
export const FMT_CODE = "\x1b[48;5;235m\x1b[37m"; // gray bg — inline code
export const FMT_HEADER = "\x1b[1;37m"; // bold white — headings
export const FMT_MUTED = "\x1b[2;37m"; // dim white — blockquotes
export const FMT_WHITE = "\x1b[0;37m"; // reset to white

/** Apply inline markdown formatting: **bold**, *italic*, `code`, [links](url). */
export function applyInlineFmt(text: string): string {
  // Bold **text**
  text = text.replace(/\*\*(.+?)\*\*/g, FMT_BOLD + "$1" + FMT_WHITE);
  // Italic *text* (not **, not list marker)
  text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, FMT_ITALIC + "$1" + FMT_WHITE);
  // Inline code `text`
  text = text.replace(/`([^`\n]+)`/g, FMT_CODE + "$1" + FMT_WHITE);
  // Links [text](url)
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, FMT_LINK + "$1" + FMT_WHITE);
  return text;
}

/** Apply line-start markdown formatting: headings, blockquotes, lists. */
export function applyLineStartFmt(line: string): string {
  // Heading # ## ### etc.
  const hdrMatch = line.match(/^(#{1,3})\s+(.+)/);
  if (hdrMatch) {
    const level = hdrMatch[1]!.length;
    const prefix = level === 1 ? "▌" : level === 2 ? "▎" : "▏";
    const sz = level === 1 ? "" : level === 2 ? "\x1b[2m" : "\x1b[2m";
    return FMT_HEADER + sz + prefix + " " + hdrMatch[2]! + FMT_WHITE;
  }
  // Blockquote >
  if (line.startsWith(">")) {
    return FMT_MUTED + "▎ " + line.slice(1).trim() + FMT_WHITE;
  }
  // Unordered list - or *
  if (/^[-*]\s/.test(line)) {
    return line.replace(/^[-*]\s/, "\x1b[33m•\x1b[0;37m ");
  }
  // Ordered list 1. 2. etc
  if (/^\d+\.\s/.test(line)) {
    return line.replace(/^(\d+\.)\s/, "\x1b[33m$1\x1b[0;37m ");
  }
  return line;
}
