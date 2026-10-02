export declare const root: string;
export interface Toolchain {
  version: string; binaryUrl: string; binarySha256: string;
  sourceUrl: string; sourceRevision: string; sourceSha256: string;
}
export declare const toolchain: Toolchain;
export interface BendEnv extends Record<string, string | undefined> {
  BEND_NO_TELEMETRY: string;
  BEND_NO_UPDATE: string;
}
export declare function getBendEnv(): BendEnv;
export declare function resolveBendExecutable(): string;
export declare function resolveBendSource(): string;
export declare function assertPinnedCompiler(bend: string): string;
