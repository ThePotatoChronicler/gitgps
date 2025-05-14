export function assertUnreachable(x: never): never {
  throw new Error(`Case not handled: ${x}`);
}
