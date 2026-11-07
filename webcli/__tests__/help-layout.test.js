import { describe, it, expect } from 'vitest';
import { renderAdapterHelp, renderCommandHelp } from '../progressive-help.js';
const command = { id: 'approve', name: 'demo.approve', description: 'Approve a ticket. Detailed guidance belongs to command help.\nMore guidance.', runtime: 'extension', safety: 'write', requires_confirmation: true, params: [{ name: 'id', type: 'string', required: true, description: 'Ticket ID' }, { name: 'mode', type: 'enum', required: false, enum: ['request', 'event'], default: 'request' }] };
const adapter = { id: 'demo', description: 'Ticket commands', commands: [command] };
describe('native CLI help layout', () => {
  it('keeps one summary per command and omits parameter details at site level', () => {
    const output = renderAdapterHelp(adapter);
    expect(output.startsWith('Usage: webcli demo <command> [options]')).toBe(true);
    expect(output).toContain('approve  Approve a ticket');
    expect(output).not.toContain('Detailed guidance');
    expect(output).not.toContain('--id');
    expect(output).not.toContain('default=');
  });
  it('shows required named options, enum, default and safety at command level', () => {
    const output = renderCommandHelp(adapter, command);
    expect(output).toContain('Usage: webcli demo approve [options]');
    expect(output).toContain('--id=<string>');
    expect(output).toContain('(required)');
    expect(output).toContain('enum=request|event');
    expect(output).toContain('[default="request"]');
    expect(output).not.toContain('Confirmation: required');
    expect(output).not.toContain('Arguments (required)');
  });
});
