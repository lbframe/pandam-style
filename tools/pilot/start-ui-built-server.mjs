/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function main() {
  const origin = process.env.PMS_PILOT_ORIGIN ?? 'http://127.0.0.1:3102';
  const parsed = new URL(origin);
  const databaseUrl = new URL(process.env.DATABASE_URL);
  databaseUrl.hostname = process.env.PMS_PILOT_DB_HOST ?? '127.0.0.1';
  databaseUrl.port = process.env.PMS_PILOT_DB_PORT ?? '55432';

  process.env.DATABASE_URL = databaseUrl.href;
  process.env.VITE_BASE_URL = origin;
  process.env.AUTH_ALLOWED_HOSTS = [
    ...new Set([
      ...(process.env.AUTH_ALLOWED_HOSTS ?? '').split(',').filter(Boolean),
      parsed.host,
    ]),
  ].join(',');
  process.env.AUTH_TRUSTED_ORIGINS = [
    ...new Set([
      ...(process.env.AUTH_TRUSTED_ORIGINS ?? '').split(',').filter(Boolean),
      origin,
    ]),
  ].join(',');
  process.env.HOST = '127.0.0.1';
  process.env.PORT = parsed.port;
  process.env.NITRO_HOST = '127.0.0.1';
  process.env.NITRO_PORT = parsed.port;

  await import(pathToFileURL(path.resolve('.output/server/index.mjs')).href);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
