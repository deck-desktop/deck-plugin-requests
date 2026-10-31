// `import code from "./x.worker.ts?worker"`: that worker, bundled by the SDK's build, as the text
// of a script (see httpscript.ts).
declare module "*?worker" {
  const code: string;
  export default code;
}
