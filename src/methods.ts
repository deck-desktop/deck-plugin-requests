// Method colours, shared by the picker, the tree, the tabs and history.
//
// In their own module rather than beside MethodPicker so that file exports only its component —
// a mixed component/constant module cannot be hot-reloaded by Fast Refresh.
import type { Method } from "./httpclient";

export const METHOD_TONE: Record<Method, string> = {
  GET: "text-emerald-400", POST: "text-amber-400", PUT: "text-blue-400",
  PATCH: "text-violet-400", DELETE: "text-red-400", HEAD: "text-pink-400", OPTIONS: "text-cyan-400",
};

// The same colours as CSS values alongside the class, because the picker's dot and its glow are
// inline styles. Deck's tone channels, so a light theme darkens them along with the classes.
export const METHOD_HEX: Record<Method, string> = {
  GET: "rgb(var(--tone-emerald-400))", POST: "rgb(var(--tone-amber-400))", PUT: "rgb(var(--tone-blue-400))",
  PATCH: "rgb(var(--tone-violet-400))", DELETE: "rgb(var(--tone-red-400))", HEAD: "rgb(var(--tone-pink-400))",
  OPTIONS: "rgb(var(--tone-cyan-400))",
};

export const METHOD_DESC: Record<Method, string> = {
  GET: "Read a resource",
  POST: "Create or submit",
  PUT: "Replace a resource",
  PATCH: "Partially update",
  DELETE: "Remove a resource",
  HEAD: "Headers only",
  OPTIONS: "Allowed methods",
};
