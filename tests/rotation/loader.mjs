import { existsSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const root = new URL('../../', import.meta.url);
const require = createRequire(new URL('package.json', root));
function source(url) {
  let path = fileURLToPath(url);
  if (existsSync(path) && statSync(path).isDirectory()) path += '/index.js';
  else if (!existsSync(path) && existsSync(path + '.js')) path += '.js';
  return pathToFileURL(path).href;
}
export async function resolve(specifier, context, next) {
  // Adapter fixtures own fetch; the proxy transport itself is tested by Vitest.
  if (specifier.endsWith("/proxyFetch.js") && context.parentURL?.includes("/open-sse/services/usage/")) return { url: "data:text/javascript," + encodeURIComponent("export const proxyAwareFetch=(...args)=>globalThis.fetch(...args);"), shortCircuit: true };
  if (specifier === 'node-machine-id') return { url: 'data:text/javascript,' + encodeURIComponent(`import m from ${JSON.stringify(pathToFileURL(require.resolve(specifier)).href)}; export const machineIdSync=m.machineIdSync; export const machineId=m.machineId; export default m;`), shortCircuit: true };
  if (specifier.startsWith('@/')) return { url: source(new URL('src/' + specifier.slice(2), root)), shortCircuit: true };
  if (specifier.startsWith('open-sse/')) return { url: source(new URL(specifier, root)), shortCircuit: true };
  if (specifier === 'open-sse') return { url: new URL('open-sse/index.js', root).href, shortCircuit: true };
  if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href)) return { url: source(new URL(specifier, context.parentURL)), shortCircuit: true };
  try { return await next(specifier, context); }
  catch (error) {
    try { return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true }; }
    catch { throw error; }
  }
}
