import { GenerationHarnessError } from './errors.js';

function valueMatchesType(value, type) {
  if (Array.isArray(type)) return type.some(candidate => valueMatchesType(value, candidate));
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'null') return value === null;
  return typeof value === type;
}

function validateSchema(value, schema = {}, path = '$') {
  if (!schema || typeof schema !== 'object') return [];
  const errors = [];
  if (schema.type && !valueMatchesType(value, schema.type)) {
    return [`${path} must be ${schema.type}`];
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of: ${schema.enum.join(', ')}`);
  }
  if (typeof value === 'number' && typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path} must be at least ${schema.minimum}`);
  if (typeof value === 'string' && Number.isInteger(schema.minLength) && [...value].length < schema.minLength) errors.push(`${path} requires at least ${schema.minLength} characters`);
  if (Array.isArray(value) && Number.isInteger(schema.minItems) && value.length < schema.minItems) errors.push(`${path} requires at least ${schema.minItems} items`);
  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties || {};
    for (const requiredKey of schema.required || []) {
      if (!(requiredKey in value)) errors.push(`${path}.${requiredKey} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) errors.push(`${path}.${key} is not allowed`);
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in value) errors.push(...validateSchema(value[key], childSchema, `${path}.${key}`));
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => errors.push(...validateSchema(item, schema.items, `${path}[${index}]`)));
  }
  return errors;
}

export class ToolRegistry {
  constructor(tools = []) {
    this.tools = new Map();
    for (const tool of tools) this.register(tool);
  }

  register(tool) {
    const name = String(tool?.name || '').trim();
    if (!name) throw new Error('tool name is required');
    if (typeof tool.execute !== 'function') throw new Error(`tool ${name} requires execute()`);
    if (this.tools.has(name)) throw new Error(`duplicate tool: ${name}`);
    this.tools.set(name, {
      name,
      description: String(tool.description || ''),
      parameters: tool.parameters || { type: 'object', properties: {} },
      execute: tool.execute,
    });
    return this;
  }

  listForModel() {
    return [...this.tools.values()].map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
  }

  async execute(call, context = {}) {
    const name = String(call?.name || '').trim();
    const tool = this.tools.get(name);
    if (!tool) {
      throw new GenerationHarnessError(`unknown generation tool: ${name}`, 'UNKNOWN_GENERATION_TOOL', { name });
    }
    const input = call?.arguments ?? {};
    const validationErrors = validateSchema(input, tool.parameters);
    if (validationErrors.length > 0) {
      throw new GenerationHarnessError(
        `invalid arguments for ${name}: ${validationErrors.join('; ')}`,
        'INVALID_TOOL_ARGUMENTS',
        { name, validationErrors },
      );
    }
    return tool.execute(input, context);
  }
}

export function validateToolArguments(value, schema) {
  return validateSchema(value, schema);
}
