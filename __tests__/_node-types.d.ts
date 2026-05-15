/**
 * Minimal ambient declarations for `node:test` and `node:assert` so the
 * test suite type-checks without depending on @types/node. These mirror
 * just the surface used by our tests; once @types/node is installed via
 * `npm i`, this file becomes redundant but harmless.
 */

declare module 'node:test' {
  type TestFn = () => void | Promise<void>;
  type SuiteFn = () => void;

  export function describe(name: string, fn: SuiteFn): void;
  export function it(name: string, fn: TestFn): void;
  export function test(name: string, fn: TestFn): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export function before(fn: () => void | Promise<void>): void;
  export function after(fn: () => void | Promise<void>): void;
}

declare module 'node:assert' {
  interface AssertionFns {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    match(actual: string, regex: RegExp, message?: string): void;
    rejects(
      block: Promise<unknown> | (() => Promise<unknown>),
      check?: RegExp | ((err: unknown) => boolean) | object,
      message?: string,
    ): Promise<void>;
    throws(
      block: () => unknown,
      check?: RegExp | ((err: unknown) => boolean) | object,
      message?: string,
    ): void;
    fail(message?: string): never;
  }
  const assert: AssertionFns & { strict: AssertionFns };
  export = assert;
}
