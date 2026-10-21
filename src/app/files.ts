/** Exact copy for DWG files (brief, part 2). */
export const DWG_MESSAGE = "DWG isn't supported. Export as DXF (SAVEAS, DXF 2013 ASCII, or use ODA File Converter) and try again.";

/** P3: binary DXF files are rejected the same way. */
export const BINARY_DXF_MESSAGE = 'This DXF is saved in binary format. Save it as ASCII DXF (DXF 2013 ASCII) and try again.';

export type FileKind = 'dxf' | 'dwg' | 'binary-dxf' | 'json' | 'unknown';

const BINARY_SENTINEL = 'AutoCAD Binary DXF';

/** Sniffs the first bytes as well as the name, so renamed files are still caught. */
export async function classifyFile(file: File): Promise<FileKind> {
  const name = file.name.toLowerCase();
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const text = String.fromCharCode(...head);
  // DWG files start with their version string, for example "AC1032".
  if (/^AC10[0-9]{2}/.test(text) || name.endsWith('.dwg')) return 'dwg';
  if (text.startsWith(BINARY_SENTINEL)) return 'binary-dxf';
  const trimmed = text.replace(/^﻿/, '').trimStart();
  if (name.endsWith('.json') || trimmed.startsWith('{')) return 'json';
  if (name.endsWith('.dxf') || /^0\s*\r?\n\s*SECTION/i.test(trimmed) || /^999\s*\r?\n/.test(trimmed)) return 'dxf';
  return 'unknown';
}
