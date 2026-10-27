/**
 * JSON vocabulary for the protocol.
 *
 * The protocol package has no runtime dependencies, so it carries its own copy
 * of the JSON types rather than importing the Core's. The two are structurally
 * compatible on purpose, in both directions: a value that type-checks as
 * `JsonValue` here is also a `JsonValue` in `@super-agent/core`, and a Core
 * `JsonObject` is assignable to this one.
 *
 * Arrays are `readonly`. The Core's own `JsonValue` allows a mutable array, so
 * it is assignable to this one — but the reverse only holds if this one is the
 * narrower type. Every payload in this package is readonly (a `ServerInfo` is
 * handed to callers who must not mutate it), and an event payload has to accept
 * those payloads as they are.
 */

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };
