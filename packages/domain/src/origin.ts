import { ContractError } from './denver.js';

/** A bare https origin for the email button. No path, query, userinfo, or plain-text URL fallback. */
export function validateAppOrigin(value: string | null | undefined, env: 'development' | 'production'): string | null {
  if (value == null || value.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ContractError('invalid_app_origin');
  }
  if (url.username || url.password || url.search || url.hash) throw new ContractError('invalid_app_origin');
  if (url.pathname !== '/' && url.pathname !== '') throw new ContractError('invalid_app_origin');
  if (env === 'production') {
    if (url.protocol !== 'https:') throw new ContractError('invalid_app_origin');
  } else if (url.protocol === 'http:') {
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') throw new ContractError('invalid_app_origin');
  } else if (url.protocol !== 'https:') {
    throw new ContractError('invalid_app_origin');
  }
  return url.origin;
}
