/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

async function main() {
  const require = createRequire(`${process.cwd()}/package.json`);
  const startedAt = performance.now();
  const origin = process.env.PMS_PILOT_ORIGIN;

  if (origin) {
    const parsed = new URL(origin);
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
  }

  if (process.env.PMS_PILOT_DB_PORT) {
    const databaseUrl = new URL(process.env.DATABASE_URL);
    databaseUrl.port = process.env.PMS_PILOT_DB_PORT;
    if (process.env.PMS_PILOT_DB_HOST) {
      databaseUrl.hostname = process.env.PMS_PILOT_DB_HOST;
    }
    process.env.DATABASE_URL = databaseUrl.href;
  }

  const vitePath = pathToFileURL(require.resolve('vite')).href;
  const { createServer } = await import(vitePath);
  const port = Number(process.env.PMS_PILOT_PORT ?? 3101);
  const server = await createServer({
    server: { host: '127.0.0.1', port, strictPort: true },
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      await server.close();
      process.exit(0);
    });
  }

  await server.listen();
  server.printUrls();
  console.log(
    `PMS_PILOT_READY_MS=${Math.round(performance.now() - startedAt)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
