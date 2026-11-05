import { validateAppOrigin } from '@ours/domain';

export type AppConfig = {
  env: 'development' | 'production';
  pepper: string;
  rpId: string;
  rpName: string;
  origins: string[];
  cookieSecure: boolean;
  cookieSameSite: 'Lax' | 'Strict' | 'None';
  sessionTtlSeconds: number;
  challengeTtlSeconds: number;
  setupCodeTtlSeconds: number;
  appOrigin: string | null;
};

const TEST_PEPPER = 'dev-only-test-pepper-0123456789abcd';

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

export function loadConfigFromEnv(env: Record<string, string | undefined>): AppConfig {
  const name = env.OURS_ENV;
  if (name !== 'development' && name !== 'production') {
    throw new Error('OURS_ENV must be development or production');
  }
  const pepper = env.OURS_CODE_PEPPER ?? '';
  if (pepper.length < 32) throw new Error('OURS_CODE_PEPPER must be at least 32 characters');
  if (name === 'production' && (pepper === TEST_PEPPER || pepper.includes('dev-only'))) {
    throw new Error('OURS_CODE_PEPPER is not usable in production');
  }

  const rpId = name === 'production' ? required(env, 'OURS_RP_ID') : (env.OURS_RP_ID?.trim() || 'localhost');
  if (name === 'production' && (rpId === 'localhost' || rpId === '127.0.0.1')) {
    throw new Error('OURS_RP_ID cannot be a loopback name in production');
  }
  if (!/^[A-Za-z0-9.-]+$/.test(rpId)) throw new Error('OURS_RP_ID is invalid');

  const originText =
    env.OURS_ORIGINS?.trim() ||
    (name === 'development' ? 'http://localhost:41773,http://127.0.0.1:41773' : '');
  if (!originText) throw new Error('OURS_ORIGINS is required');
  const origins = originText.split(',').map((origin) => origin.trim()).filter(Boolean);
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error('OURS_ORIGINS contains an invalid origin');
    }
    if (url.origin !== origin || (name === 'production' && url.protocol !== 'https:')) {
      throw new Error('OURS_ORIGINS must be a bare https origin in production');
    }
  }

  const cookieSecure = name === 'production' ? true : env.OURS_COOKIE_SECURE === 'true';
  if (name === 'production' && env.OURS_COOKIE_SECURE === 'false') {
    throw new Error('OURS_COOKIE_SECURE cannot be false in production');
  }
  const same = env.OURS_COOKIE_SAMESITE ?? (name === 'production' ? 'Strict' : 'Lax');
  if (same !== 'Lax' && same !== 'Strict' && same !== 'None') throw new Error('OURS_COOKIE_SAMESITE is invalid');
  if (same === 'None' && !cookieSecure) throw new Error('SameSite=None requires a secure cookie');

  return {
    env: name,
    pepper,
    rpId,
    rpName: 'Ours',
    origins,
    cookieSecure,
    cookieSameSite: same,
    sessionTtlSeconds: 60 * 60 * 12,
    challengeTtlSeconds: 120,
    setupCodeTtlSeconds: 60 * 30,
    appOrigin: validateAppOrigin(env.OURS_APP_ORIGIN, name),
  };
}
