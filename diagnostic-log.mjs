import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

export function diagnosticLog(directory, limit = 512 * 1024) {
  const file = path.join(directory, 'reader.log');
  let warned = false;
  function write(level, {event, code, status}) {
    // Never serialize the original object: it may contain model data or credentials.
    const line = JSON.stringify({time:new Date().toISOString(), level, event,
      ...(typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,47}$/.test(code) ? {code} : {}),
      ...(Number.isInteger(status) ? {status} : {})}) + '\n';
    try {
      mkdirSync(directory, {recursive:true});
      if ((statSync(file,{throwIfNoEntry:false})?.size ?? 0) + Buffer.byteLength(line) > limit)
        renameSync(file,path.join(directory,'reader.previous.log'));
      appendFileSync(file,line,{mode:0o600});
      warned = false;
    } catch {
      if (!warned) console.warn('Diagnostický log nie je zapisovateľný. Reader pokračuje bez zápisu.');
      warned = true;
    }
  }
  return {info:record=>write('INFO',record), error:record=>write('ERROR',record)};
}
