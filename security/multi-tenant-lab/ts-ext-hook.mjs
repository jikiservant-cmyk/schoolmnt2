// ESM resolver hook: lets Node load najiki-finance2's TypeScript directly.
//
// Their sources use bundler-style extensionless relative imports (`./money`),
// which Node's resolver rejects. This maps a failed relative specifier to the
// matching .ts / .tsx / /index.ts file so the provider's REAL schema and
// signature code can be imported instead of re-implemented.
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    const relative = specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/');
    if (err?.code !== 'ERR_MODULE_NOT_FOUND' || !relative || !context.parentURL) throw err;
    const base = fileURLToPath(new URL(specifier, context.parentURL));
    for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
      if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
    throw err;
  }
}
