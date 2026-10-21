import type { FloorPlan } from '../data/schema';
import { parseDxf } from '../data/loader';
import { el } from './dom';

export interface ImportHandlers {
  build(plan: FloorPlan): void;
  demo(): void;
  cancel(): void;
  message(title: string, body: string, details?: string[]): void;
}

/**
 * DXF import flow: parse in a worker, ask for units if needed, map layers, review, build.
 * The full flow lands with the DXF pipeline (milestone M6).
 */
export class ImportFlow {
  readonly root: HTMLElement;

  constructor(private h: ImportHandlers) {
    this.root = el('section', { class: 'screen', hidden: true, 'data-testid': 'import-flow' });
  }

  async open(file: File): Promise<void> {
    try {
      await parseDxf(file);
    } catch (e) {
      this.h.message("Can't import this DXF yet", (e as Error).message);
    }
  }

  hide(): void {
    this.root.hidden = true;
  }
}
