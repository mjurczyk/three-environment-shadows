import { resolveObjectURL } from 'node:buffer';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EnvironmentLightExtractor } from 'three-environment-shadows';
import { createEnvironment, paintSun } from './utils.js';

// NOTE Runs the worker code in an empty context, so it fails if the code needs the module scope
class ContextWorker {
  constructor(url) {
    this.code = resolveObjectURL(url).text();
  }

  async postMessage(data) {
    const self = { postMessage: (output) => this.onmessage({ data: output }) };

    try {
      vm.runInNewContext(await this.code, { self });
      self.onmessage({ data });
    } catch (error) {
      this.onerror({ message: error.message });
    }
  }

  terminate() {}
}

describe('EnvironmentLightExtractor worker', () => {
  beforeEach(() => {
    globalThis.Worker = ContextWorker;
  });

  afterEach(() => {
    delete globalThis.Worker;
  });

  it('gives the same result as the analysis without a worker', async () => {
    const texture = createEnvironment(paintSun(Math.PI / 6, Math.PI / 3, [5000, 4000, 3000]));

    const inWorker = await EnvironmentLightExtractor.extract(texture);

    delete globalThis.Worker;

    const inThread = await EnvironmentLightExtractor.extract(texture);

    expect(inWorker.lights).toHaveLength(1);
    expect(inWorker.lights).toEqual(inThread.lights);
    expect(inWorker.texture.image.data).toEqual(inThread.texture.image.data);
  });
});
