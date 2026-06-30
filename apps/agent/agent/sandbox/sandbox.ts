import { defineSandbox } from 'eve/sandbox';
import { justbash } from 'eve/sandbox/just-bash';

/**
 * Pin the dependency-free `just-bash` sandbox backend.
 *
 * The agent runs inside a container with no Docker daemon, so `defaultBackend()`
 * (which would try Docker first off-Vercel) is the wrong choice here. The pure-JS
 * `just-bash` interpreter backs the default harness's shell/file tools without a
 * daemon or VM. Our agent only needs the `ping` tool, but pinning this keeps the
 * runtime self-contained if a default tool is ever invoked.
 */
export default defineSandbox({
  backend: justbash(),
});
