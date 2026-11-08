/** Types for env.mjs, so TypeScript tests can import the setup scripts' helpers. */
export function loadEnv(files?: string[]): void;
export function normalizeId(raw: unknown): string | null;
export const ok: (msg: string) => void;
export const bad: (msg: string) => void;
export const warn: (msg: string) => void;
export const info: (msg: string) => void;
export function isNetworkError(error: unknown): boolean;
export function describeFailure(error: unknown): { summary: string; advice: string[] };
