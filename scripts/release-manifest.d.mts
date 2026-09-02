export declare const repositoryRoot: string;
export declare const releaseName: string;
export declare const releaseDependencies: () => Record<string, string>;
export declare const releaseVersion: () => string;
export declare const releasePnpmVersion: () => string;
export declare const toolCommand: (name: string) => string;
export declare const toolSpawnOptions: () => Record<string, unknown>;
