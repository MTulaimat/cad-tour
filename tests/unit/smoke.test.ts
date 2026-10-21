import { describe, expect, it } from 'vitest';
import { REVISION } from 'three';

describe('toolchain', () => {
  it('loads three', () => {
    expect(Number(REVISION)).toBeGreaterThan(150);
  });
});
