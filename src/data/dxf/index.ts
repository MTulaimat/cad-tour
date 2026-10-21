import type { FloorPlan } from '../schema';
import type { BuildRequest, ImportReport } from './types';
import type { DxfSummary, PreviewData, WorkerIn, WorkerOut } from './protocol';
import { sha256 } from './layers';

export type { DxfSummary, PreviewData } from './protocol';
export * from './types';

export interface DxfImportOptions {
  onProgress?: (fraction: number, label: string) => void;
}

/**
 * One DXF import: the file is parsed in a Web Worker (nothing is uploaded), then built into a
 * FloorPlan as many times as the user adjusts the mapping or settings.
 */
export class DxfImportSession {
  private worker: Worker;
  private pending: { resolve: (m: WorkerOut) => void; reject: (e: Error) => void } | null = null;
  summary!: DxfSummary;
  preview!: PreviewData;
  hash = '';

  private constructor(
    readonly fileName: string,
    private onProgress: (f: number, label: string) => void,
  ) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'dxf-import' });
    this.worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      if (m.type === 'progress') {
        this.onProgress(m.fraction, m.label);
        return;
      }
      const p = this.pending;
      this.pending = null;
      if (!p) return;
      if (m.type === 'error') {
        const err = new Error(m.message) as Error & { details?: string[] };
        err.details = m.details;
        p.reject(err);
      } else p.resolve(m);
    };
    this.worker.onerror = (e) => {
      const p = this.pending;
      this.pending = null;
      p?.reject(new Error(e.message || 'The DXF reader stopped unexpectedly.'));
    };
  }

  private send(msg: WorkerIn, transfer: Transferable[] = []): Promise<WorkerOut> {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.worker.postMessage(msg, transfer);
    });
  }

  static async open(file: File, options: DxfImportOptions = {}): Promise<DxfImportSession> {
    const s = new DxfImportSession(file.name, options.onProgress ?? (() => {}));
    const bytes = await file.arrayBuffer();
    s.hash = await sha256(bytes);
    const m = await s.send({ type: 'parse', bytes }, [bytes]);
    if (m.type !== 'parsed') throw new Error('Unexpected reply from the DXF reader.');
    s.summary = m.summary;
    s.preview = m.preview;
    return s;
  }

  async build(request: BuildRequest): Promise<{ plan: FloorPlan; report: ImportReport }> {
    const m = await this.send({ type: 'build', request });
    if (m.type !== 'built') throw new Error('Unexpected reply from the DXF reader.');
    return { plan: m.plan, report: m.report };
  }

  dispose(): void {
    this.worker.terminate();
  }
}

export async function startDxfImport(file: File, options: DxfImportOptions = {}): Promise<DxfImportSession> {
  return DxfImportSession.open(file, options);
}
