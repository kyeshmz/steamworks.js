export function init(appId?: number): Omit<Client, "init" | "runCallbacks" | "restartAppIfNecessary"> & {
    sdk: typeof import("./lib/sdk");
};
export function initGameServer(unIP: number, usGamePort: number, usQueryPort: number, eServerMode: number, pchVersionString: string): void;
export function shutdownGameServer(): void;
export function restartAppIfNecessary(appId: number): boolean;
export function electronEnableSteamOverlay(disableEachFrameInvalidation?: boolean): void;
export type Client = typeof import("./client.d");
export const SteamCallback: typeof import("./client.d").callback.SteamCallback;
/**
 * The 1:1 Steamworks SDK layer: every ISteam* interface under its C++ accessor
 * name (`sdk.SteamUserStats.SetAchievement(...)`), every struct, callback,
 * enum and constant. See docs/guide/sdk.md.
 * @type {typeof import('./lib/sdk')}
 */
export const sdk: typeof import("./lib/sdk");
