// The retired confirmation marker is accepted only for old callers, never sent
// to an Adapter or a business API. Do not recursively strip business payloads.
export function businessArgs(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const { __confirmed: ignored, ...business } = args;
  return business;
}

export function businessSchema(schema = {}) {
  const { 'x-webcli-requires-confirmation': ignored, 'x-webcli-confirmation-message': message, ...result } = schema;
  return { ...result, ...(schema.properties ? { properties: businessArgs(schema.properties) } : {}),
    ...(Array.isArray(schema.required) ? { required: schema.required.filter(key => key !== '__confirmed') } : {}) };
}
