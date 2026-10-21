// DXF import entry point. The full pipeline lands in milestone M6; until then this stub
// rejects with a clear message so callers can fall back to the demo apartment.

export interface DxfImportOptions {
  onProgress?: (fraction: number, label: string) => void;
}

export interface DxfImportSession {
  fileName: string;
}

export async function startDxfImport(file: File, _options: DxfImportOptions = {}): Promise<DxfImportSession> {
  throw new Error(`DXF import is not available yet (${file.name}).`);
}
