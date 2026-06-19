// aidlc-omp-hooks.d.ts — ambient declarations for the @oh-my-pi/pi-coding-agent
// module so static analyzers (biome/IDE/typecheck) accept the hook bodies.
// The shipping runtime supplies the real @oh-my-pi/pi-coding-agent package;
// this file declares just enough surface for type-checking until the SDK is
// installed. At runtime, the `import type` lines become inert.
declare module "@oh-my-pi/pi-coding-agent/extensibility/hooks" {
  export type HookAPI = {
    on(event: string, handler: (event: any) => void | Promise<void>): void;
    off(event: string, handler: (event: any) => void | Promise<void>): void;
    notify?(msg: any): void;
    cwd: string;
    exec?: (cmd: string, args: string[], opts?: { cwd?: string; signal?: AbortSignal }) => Promise<{
      code: number;
      stdout: string;
      stderr: string;
    }>;
  };
}
declare module "@oh-my-pi/pi-coding-agent" {
  export type CustomToolFactory = (pi: any) => {
    name: string;
    label?: string;
    description: string;
    parameters: any;
    execute: (
      toolCallId: string,
      params: any,
      onUpdate?: (partial: any) => void,
      ctx?: any,
      signal?: AbortSignal,
    ) => Promise<{ content: any[]; details?: unknown; isError?: boolean }>;
    renderCall?: (args: any) => any;
    renderResult?: (result: any) => any;
  };
}
export {};
