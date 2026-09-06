import { describe, expect, it } from 'vitest';

import { parseEnvironment } from '../../src/infrastructure/environment.js';

describe('environment', () => {
  it('uses safe local defaults', () => {
    expect(parseEnvironment({})).toMatchObject({
      HOST: '0.0.0.0',
      PORT: 7000,
      LOG_LEVEL: 'info',
    });
  });

  it('rejects invalid ports', () => {
    expect(() => parseEnvironment({ PORT: '70000' })).toThrow();
  });
});
