/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Internal-fork hardening (_security-review/02-supply-chain-audit.md):
//
// Drop-in replacement for `typed-regex` (single-maintainer, abandoned
// per supply-chain audit). Same surface used by the codebase:
//   const r = TypedRegEx(pattern, flags) as {
//     isMatch(val): boolean;
//     captures(val): undefined | NamedGroups;
//   };
//
// This is ~15 lines of vanilla RegExp wrapping. The only subtlety is
// preserving safe semantics under the `g` and `y` flags (where the
// underlying RegExp keeps lastIndex state) -- we always use a fresh
// RegExp per `.exec()` / `.test()` call to avoid call-order-dependent
// matches, which is the same behavior the upstream `typed-regex`
// provides.

export interface TypedRegExMatchResult<T> {
  matched: boolean;
  groups?: T;
  raw?: RegExpExecArray;
}

export interface TypedRegExLike<T> {
  /** Returns true iff the string matches the pattern. */
  isMatch(value: string): boolean;
  /** Returns the named capture groups, or undefined if no match. */
  captures(value: string): T | undefined;
  /** Compatibility alias used by some consumers: returns matched + groups. */
  match(value: string): TypedRegExMatchResult<T>;
}

// Default T matches TS's lib type for RegExpMatchArray.groups (each group is
// `string`, not `string | undefined`). Call sites that have optional groups
// should cast the result of `TypedRegEx(...)` to a specific shape, the same
// way they did with the upstream typed-regex package.
export function TypedRegEx<T = Record<string, string>>(pattern: string, flags?: string): TypedRegExLike<T> {
  // Strip stateful flags so consumers can call isMatch/captures repeatedly
  // without surprising lastIndex behavior, matching upstream typed-regex.
  const safeFlags = (flags ?? "").replace(/[gy]/g, "");
  return {
    isMatch(value: string): boolean {
      return new RegExp(pattern, safeFlags).test(value);
    },
    captures(value: string): T | undefined {
      const match = new RegExp(pattern, safeFlags).exec(value);
      return (match?.groups as T | undefined) ?? undefined;
    },
    match(value: string): TypedRegExMatchResult<T> {
      const raw = new RegExp(pattern, safeFlags).exec(value);
      if (!raw) return { matched: false };
      return {
        matched: true,
        groups: (raw.groups as T | undefined) ?? undefined,
        raw,
      };
    },
  };
}
