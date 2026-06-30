import { eveChannel } from 'eve/channels/eve';
import { httpBasic, localDev, type AuthFn } from 'eve/channels/auth';

/**
 * Route-auth policy for the public HTTP endpoint.
 *
 * The agent sits behind Traefik on a public host, so it must fail closed:
 *  - `httpBasic(...)` gates production traffic with a shared operator credential
 *    (`ROUTE_AUTH_BASIC_USER` / `ROUTE_AUTH_BASIC_PASSWORD`, from the env).
 *  - `localDev()` admits loopback requests (the container healthcheck and local
 *    `eve dev`), which never reach the public host.
 *
 * `GET /eve/v1/health` is always public and skips this walk, so Traefik and the
 * container healthcheck can probe it without credentials.
 */
function operatorBasicAuth(): AuthFn<Request>[] {
  const password = process.env.ROUTE_AUTH_BASIC_PASSWORD;
  if (!password) return [];
  return [
    httpBasic({
      username: process.env.ROUTE_AUTH_BASIC_USER ?? 'istatym',
      password,
    }),
  ];
}

export default eveChannel({
  auth: [...operatorBasicAuth(), localDev()],
});
