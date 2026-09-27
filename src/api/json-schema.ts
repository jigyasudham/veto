// The published JSON Schemas, derived from the zod contract so the two cannot
// differ. A request schema describes what a caller may send (defaults make a
// field optional); a data schema describes what Veto returns.

import { z } from 'zod';
import { PUBLISHED_SCHEMAS } from './contract.js';

export function contractJsonSchemas(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, schema] of Object.entries(PUBLISHED_SCHEMAS)) {
    const json = z.toJSONSchema(schema as z.ZodType, { io: name.endsWith('.request') ? 'input' : 'output', unrepresentable: 'any' });
    out[name] = JSON.stringify({ $id: `https://github.com/jigyasudham/veto/contracts/api-v1/${name}.schema.json`, ...json }, null, 2) + '\n';
  }
  return out;
}
