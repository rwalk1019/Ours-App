import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { initialFacts, presentSample } from '../demo/sample';
import { HouseholdScreen, type HouseholdActions } from './HouseholdScreen';

const actions: HouseholdActions = {
  setTithing: async () => undefined,
  saveTarget: async () => undefined,
  deleteTarget: async () => undefined,
  saveRule: async () => undefined,
  deleteRule: async () => undefined,
  saveItem: async () => undefined,
  deleteItem: async () => undefined,
  classify: async () => undefined,
  refresh: async () => 'requested',
  setCovered: async () => undefined,
  addPayment: async () => undefined,
};

function html(situation: 'ready' | 'unconfigured' | 'empty' | 'stale') {
  return renderToStaticMarkup(
    <HouseholdScreen payload={presentSample(initialFacts(situation))} onPeriod={() => undefined} onShift={() => undefined} actions={actions} />,
  );
}

describe('household states', () => {
  it('shows one tithing status and does not invent a percent', () => {
    const ready = html('ready');
    expect(ready).toContain('Still to pay $240.00');
    expect(ready).not.toContain('Nothing due yet');
    const unset = html('unconfigured');
    expect(unset).toContain('Set a percent');
    expect(unset).not.toContain('Still to pay');
    expect(unset).toContain('Nothing is assumed');
    expect(html('empty')).toContain('No bank snapshot yet');
    const stale = html('stale');
    expect(stale).toContain('A later import failed');
    expect(stale).toContain('bank verification');
    expect(stale).toContain('That is not a new bank timestamp');
  });
});
