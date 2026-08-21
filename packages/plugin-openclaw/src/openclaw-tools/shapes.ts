import { Type } from "@sinclair/typebox";

export const MemorySearchInputSchema = Type.Object({
  query: Type.String(),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
  sessionKey: Type.Optional(Type.String()),
  filters: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export const MemoryGetInputSchema = Type.Object({
  id: Type.String(),
  sessionKey: Type.Optional(Type.String()),
  namespace: Type.Optional(Type.String()),
});
