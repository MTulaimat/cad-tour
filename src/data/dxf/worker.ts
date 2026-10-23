import { readDrawing, resetParseCaches } from './parse';
import { buildPlan } from './build';
import { prepareImport } from './prepare';
import type { DrawingModel } from './types';
import { summarize, type WorkerIn, type WorkerOut } from './protocol';

// DXF parsing and plan building run here, off the main thread, so the UI stays responsive.
// Nothing leaves the device: the file arrives as bytes and the plan goes back as JSON.

let model: DrawingModel | null = null;
// The DOM lib types `self` as a Window; in a worker it is the worker scope.
const scope = self as unknown as { postMessage(msg: unknown, transfer: Transferable[]): void };
const post = (msg: WorkerOut, transfer: Transferable[] = []) => scope.postMessage(msg, transfer);

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  const msg = e.data;
  try {
    if (msg.type === 'parse') {
      resetParseCaches();
      model = readDrawing(new Uint8Array(msg.bytes), (f) => post({ type: 'progress', fraction: f * 0.9, label: 'Reading the drawing' }));
      const prep = prepareImport(model);
      const { summary, preview } = summarize(model, prep.roles, prep.floors, prep.units);
      post({ type: 'parsed', summary, preview }, [preview.segs.buffer, preview.layer.buffer]);
    } else if (msg.type === 'build') {
      if (!model) throw new Error('Open a DXF file first.');
      post({ type: 'progress', fraction: 0.2, label: 'Finding walls and rooms' });
      const result = buildPlan(model, msg.request);
      post({ type: 'built', plan: result.plan, report: result.report });
    }
  } catch (err) {
    const e2 = err as Error & { details?: string[] };
    post({ type: 'error', message: e2.message || String(err), details: e2.details ?? [] });
  }
};
