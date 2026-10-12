// Method colours, shared by the picker, the tree, the tabs and history.
//
// In their own module rather than beside MethodPicker so that file exports only its component —
// a mixed component/constant module cannot be hot-reloaded by Fast Refresh.
import type { Method } from "./httpclient";

export const METHOD_TONE: Record<Method, string> = {
  GET: "text-emerald-400", POST: "text-amber-400", PUT: "text-blue-400",
  PATCH: "text-violet-400", DELETE: "text-red-400", HEAD: "text-pink-400", OPTIONS: "text-cyan-400",
};

// Hex alongside the class, because the picker's dot and its glow are inline styles.
export const METHOD_HEX: Record<Method, string> = {
  GET: "#34d399", POST: "#fbbf24", PUT: "#60a5fa",
  PATCH: "#a78bfa", DELETE: "#f87171", HEAD: "#f472b6", OPTIONS: "#22d3ee",
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
