/**
 * P4: DXF text encoding. Files from AutoCAD 2007 (AC1021) on are UTF-8. Older files use the code
 * page in $DWGCODEPAGE (for example ANSI_1256, Arabic) and may also carry \U+XXXX escapes.
 */

export interface DecodedDxf {
  text: string;
  version: string | null;
  codepage: string | null;
  encoding: string;
}

const VERSION_2007 = 1021;

/** Reads a header variable's value straight from the raw bytes (ASCII-safe). */
function sniff(head: string, name: string): string | null {
  const i = head.indexOf(name);
  if (i < 0) return null;
  // $NAME \n code \n value
  const rest = head.slice(i + name.length).split(/\r?\n/);
  return rest.length >= 3 ? rest[2].trim() : null;
}

const CODEPAGES: Record<string, string> = {
  ANSI_874: 'windows-874',
  ANSI_932: 'shift_jis',
  ANSI_936: 'gbk',
  ANSI_949: 'euc-kr',
  ANSI_950: 'big5',
  ANSI_1250: 'windows-1250',
  ANSI_1251: 'windows-1251',
  ANSI_1252: 'windows-1252',
  ANSI_1253: 'windows-1253',
  ANSI_1254: 'windows-1254',
  ANSI_1255: 'windows-1255',
  ANSI_1256: 'windows-1256',
  ANSI_1257: 'windows-1257',
  ANSI_1258: 'windows-1258',
  DOS720: 'ibm866',
};

export function codepageToEncoding(cp: string | null): string | null {
  if (!cp) return null;
  const key = cp.toUpperCase();
  return CODEPAGES[key] ?? null;
}

function tryDecoder(label: string): TextDecoder | null {
  try {
    return new TextDecoder(label, { fatal: false });
  } catch {
    return null;
  }
}

export function decodeDxf(bytes: Uint8Array): DecodedDxf {
  // The header lives in the first few kilobytes and is plain ASCII.
  const headLen = Math.min(bytes.length, 64 * 1024);
  let head = '';
  for (let i = 0; i < headLen; i++) head += String.fromCharCode(bytes[i]);
  const version = sniff(head, '$ACADVER');
  const codepage = sniff(head, '$DWGCODEPAGE');
  const num = version ? parseInt(version.replace(/^AC/i, ''), 10) : NaN;
  let encoding = 'utf-8';
  if (Number.isFinite(num) && num < VERSION_2007) {
    const cp = codepageToEncoding(codepage);
    encoding = cp ?? 'windows-1252';
  }
  let text = (tryDecoder(encoding) ?? new TextDecoder('utf-8')).decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { text, version, codepage, encoding };
}

/** \U+XXXX escapes used by AutoCAD for characters outside the file's code page. */
export function unescapeUnicode(s: string): string {
  return s.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\M\+[0-9A-Fa-f](\w{4})/g, '');
}

/** Removes MTEXT formatting codes and decodes %% escapes, leaving plain text. */
export function cleanMText(raw: string): string {
  let s = unescapeUnicode(raw);
  s = s
    .replace(/\\P/g, ' ')
    .replace(/\\~/g, ' ')
    .replace(/\\[ACcFfHhQTWw][^;]*;/g, '')
    .replace(/\\S([^;]*?)[#^/]([^;]*?);/g, '$1/$2')
    .replace(/\\[LlOoKkNn]/g, '')
    .replace(/\\p[^;]*;/g, '')
    .replace(/\\\\/g, '\\')
    .replace(/\\\{/g, '\u0001')
    .replace(/\\\}/g, '\u0002')
    .replace(/[{}]/g, '')
    .replace(/\u0001/g, '{')
    .replace(/\u0002/g, '}');
  return cleanText(s);
}

/** TEXT values: %% codes and escapes. */
export function cleanText(raw: string): string {
  return unescapeUnicode(raw)
    .replace(/%%[cC]/g, '⌀')
    .replace(/%%[dD]/g, '°')
    .replace(/%%[pP]/g, '±')
    .replace(/%%[uUoOkK]/g, '')
    .replace(/%%%/g, '%')
    .replace(/\s+/g, ' ')
    .trim();
}
