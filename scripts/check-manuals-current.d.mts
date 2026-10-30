// Hand-written declarations for check-manuals-current.mjs, for the TypeScript test.
export interface ManualScreens {
  id: string;
  path: string;
  screens: string[];
}
export declare const OPT_OUT: string;
export declare function missingManualUpdates(changedFiles: string[], pages: ManualScreens[], commitMessages: string[]): string[];
