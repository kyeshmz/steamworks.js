import * as steamworks from "@kyeshmz/steamworks.js";
import type { LobbyCreated_t, SteamCallbacks } from "@kyeshmz/steamworks.js/lib/sdk";

export default function main() {
	const client = steamworks.init(480);
	console.log(client.localplayer.getName())
	client.callback.register(steamworks.SteamCallback.GameOverlayActivated, ({ active }) => {
		const overlayVisible: boolean = active;
		console.log(overlayVisible);
	});
	const friends: bigint[] = client.friends.getFriends();
	const board: Promise<boolean> = client.leaderboards.findLeaderboard("high-scores");
	return { friends, board, sdk: sdkLayer(client.sdk) };
}

// The 1:1 SDK layer: SDK names, outputs in result objects, Promises for call results.
function sdkLayer(sdk: typeof steamworks.sdk) {
	const stat: { result: boolean; pData: number } = sdk.SteamUserStats.GetStatInt32("NumGames");
	const set: boolean = sdk.SteamUserStats.SetAchievement("ACH_WIN_ONE_GAME");
	const found: Promise<bigint> = sdk.SteamUserStats.FindLeaderboard("Feet Traveled")
		.then((r) => r.m_hSteamLeaderboard);

	const lobby = sdk.on("LobbyCreated_t", (event: LobbyCreated_t, source) => {
		const id: bigint = event.m_ulSteamIDLobby;
		const ok: boolean = event.m_eResult === sdk.EResult.k_EResultOK;
		const from: "client" | "gameServer" = source;
		console.log(id, ok, from);
	});
	lobby.disconnect();
	const next: Promise<SteamCallbacks["GameOverlayActivated_t"]> = sdk.once("GameOverlayActivated_t");

	const identity = new sdk.SteamNetworkingIdentity();
	identity.SetSteamID64(BigInt("76561197960287930"));
	const sent: number = sdk.SteamNetworkingMessages.SendMessageToUser(
		identity, new Uint8Array([1, 2, 3]), 3, sdk.k_nSteamNetworkingSend_Reliable, 0);
	const received = sdk.SteamNetworkingMessages.ReceiveMessagesOnChannel(0, 32);
	const payloads: Buffer[] = received.ppOutMessages.map((m) => m.data);

	const ticket = sdk.SteamUser.GetAuthSessionTicket(undefined, 1024, null);
	const ticketBytes: Uint8Array = ticket.pTicket.subarray(0, ticket.pcbTicket);

	const query: bigint = sdk.SteamUGC.CreateQueryAllUGCRequestPage(
		sdk.EUGCQuery.k_EUGCQuery_RankedByVote, sdk.EUGCMatchingUGCType.k_EUGCMatchingUGCType_Items, 480, 480, 1);
	const page = sdk.SteamUGC.SendQueryUGCRequest(query).then((r) => r.m_unNumResultsReturned);

	return { stat, set, found, next, sent, payloads, ticketBytes, page };
}
