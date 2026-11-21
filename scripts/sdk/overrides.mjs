// Semantics that steam_api.json does not state (or states incorrectly).
//
// The generator classifies most parameters from their C type and the JSON
// annotations (see the rules in model.mjs). The entries below cover the rest.
// Each one says why it exists; keep it that way when you add more.
//
// Parameter override fields:
//   dir:      'in' | 'out' | 'inout'   direction of a pointer parameter
//   as:       'array'                  pointer is an array, not a single value
//             'structArray'            pointer is an array of structs
//             'inout'                  scalar pointer read and written by Steam
//             'nullOnly'               Steam accepts NULL; JS cannot supply the type
//   count:    'param:<name>' | 'inout:<name>' | 'const:<NAME>' | 'fixed:<n>'
//             element count (or byte capacity for buffers) of the pointer
//   bytes:    true                     `count` is a byte size, not an element count
//   nullable: true                     JS may pass null / omit it to send NULL
//   cap:      same syntax as count     capacity of an out string buffer
//
// Method override fields:
//   status:   'manual' | 'unsupported' with `reason`
//   requiresSteam: true                struct method that calls into Steam
//   ret:      { kind: 'bytes', len: '<out param>' } for pointer-returning methods

export const methodOverrides = {
    // --- ISteamUser ---------------------------------------------------------
    SteamAPI_ISteamUser_GetVoice: {
        params: {
            pUncompressedDestBuffer_Deprecated: { nullable: true },
        },
    },
    SteamAPI_ISteamUser_GetAuthSessionTicket: {
        // Valve: pass NULL to get a ticket for any recipient.
        params: { pSteamNetworkingIdentity: { nullable: true } },
    },
    SteamAPI_ISteamGameServer_GetAuthSessionTicket: {
        params: { pSnid: { nullable: true } },
    },
    SteamAPI_ISteamUser_RequestEncryptedAppTicket: {
        // Declared `void *` but only read; may be NULL with a size of 0.
        params: { pDataToInclude: { dir: 'in', nullable: true } },
    },

    // --- documented NULL strings -------------------------------------------
    SteamAPI_ISteamFriends_SetRichPresence: {
        // Valve: "If this is set to an empty string or NULL, the key will be deleted."
        params: { pchValue: { nullable: true } },
    },
    SteamAPI_ISteamHTMLSurface_CreateBrowser: {
        params: { pchUserAgent: { nullable: true }, pchUserCSS: { nullable: true } },
    },
    SteamAPI_ISteamHTMLSurface_LoadURL: {
        params: { pchPostData: { nullable: true } },
    },

    // --- ISteamParties ------------------------------------------------------
    SteamAPI_ISteamParties_GetAvailableBeaconLocations: {
        params: { pLocationList: { as: 'structArray', dir: 'out', count: 'param:uMaxNumLocations' } },
    },
    SteamAPI_ISteamParties_CreateBeacon: {
        // Declared non-const but it is the location to create the beacon at.
        params: { pBeaconLocation: { dir: 'in' } },
    },

    // --- ISteamUserStats ----------------------------------------------------
    SteamAPI_ISteamUserStats_GetDownloadedLeaderboardEntry: {
        params: { pDetails: { as: 'array', dir: 'out', count: 'param:cDetailsMax', nullable: true } },
    },
    SteamAPI_ISteamUserStats_UploadLeaderboardScore: {
        params: { pScoreDetails: { nullable: true } },
    },
    SteamAPI_ISteamUserStats_GetGlobalStatHistoryInt64: {
        // Valve: "cubData: The total size in bytes of the pData array".
        params: { pData: { bytes: true } },
    },
    SteamAPI_ISteamUserStats_GetGlobalStatHistoryDouble: {
        params: { pData: { bytes: true } },
    },

    // --- ISteamApps ---------------------------------------------------------
    SteamAPI_ISteamApps_GetInstalledDepots: {
        params: { pvecDepots: { as: 'array', dir: 'out', count: 'param:cMaxDepots' } },
    },

    // --- ISteamNetworking (legacy P2P) ---------------------------------------
    SteamAPI_ISteamNetworking_SendDataOnSocket: {
        params: { pubData: { dir: 'in' } },
    },

    // --- ISteamScreenshots / ISteamMusicRemote / ISteamHTTP -----------------
    SteamAPI_ISteamScreenshots_WriteScreenshot: { params: { pubRGB: { dir: 'in' } } },
    SteamAPI_ISteamMusicRemote_SetPNGIcon_64x64: { params: { pvBuffer: { dir: 'in' } } },
    SteamAPI_ISteamMusicRemote_UpdateCurrentEntryCoverArt: { params: { pvBuffer: { dir: 'in' } } },
    SteamAPI_ISteamHTTP_SetHTTPRequestRawPostBody: { params: { pubBody: { dir: 'in' } } },

    // --- ISteamUGC ----------------------------------------------------------
    SteamAPI_ISteamUGC_CreateQueryUGCDetailsRequest: {
        params: { pvecPublishedFileID: { as: 'array', dir: 'in', count: 'param:unNumPublishedFileIDs' } },
    },
    SteamAPI_ISteamUGC_StartPlaytimeTracking: {
        params: { pvecPublishedFileID: { as: 'array', dir: 'in', count: 'param:unNumPublishedFileIDs' } },
    },
    SteamAPI_ISteamUGC_StopPlaytimeTracking: {
        params: { pvecPublishedFileID: { as: 'array', dir: 'in', count: 'param:unNumPublishedFileIDs' } },
    },
    SteamAPI_ISteamUGC_GetQueryUGCChildren: {
        params: { pvecPublishedFileID: { as: 'array', dir: 'out', count: 'param:cMaxEntries' } },
    },
    SteamAPI_ISteamUGC_GetSubscribedItems: {
        params: { pvecPublishedFileID: { as: 'array', dir: 'out', count: 'param:cMaxEntries' } },
    },
    SteamAPI_ISteamUGC_GetQueryUGCContentDescriptors: {
        params: { pvecDescriptors: { as: 'array', dir: 'out', count: 'param:cMaxEntries' } },
    },
    SteamAPI_ISteamUGC_GetUserContentDescriptorPreferences: {
        params: { pvecDescriptors: { as: 'array', dir: 'out', count: 'param:cMaxEntries' } },
    },
    SteamAPI_ISteamUGC_GetQueryUGCAdditionalPreview: {
        // steam_api.json annotates the file name buffer with the URL size.
        params: { pchOriginalFileName: { cap: 'param:cchOriginalFileNameSize' } },
    },

    // --- ISteamInventory ----------------------------------------------------
    SteamAPI_ISteamInventory_GetResultItems: {
        // NULL array + size query is the documented way to get the count.
        params: { pOutItemsArray: { as: 'structArray', nullable: true } },
    },
    SteamAPI_ISteamInventory_SerializeResult: {
        params: { pOutBuffer: { nullable: true } },
    },
    SteamAPI_ISteamInventory_GetItemDefinitionIDs: {
        params: { pItemDefIDs: { nullable: true } },
    },
    SteamAPI_ISteamInventory_GetEligiblePromoItemDefinitionIDs: {
        params: { pItemDefIDs: { nullable: true } },
    },
    SteamAPI_ISteamInventory_DeserializeResult: {
        // The JSON names a parameter that does not exist (punOutBufferSize).
        params: { pBuffer: { count: 'param:unBufferSize' } },
    },

    // --- ISteamNetworkingSockets --------------------------------------------
    SteamAPI_ISteamNetworkingSockets_GetConnectionRealTimeStatus: {
        params: {
            pStatus: { nullable: true },
            pLanes: { as: 'structArray', dir: 'out', count: 'param:nLanes', nullable: true },
        },
    },
    SteamAPI_ISteamNetworkingSockets_CreateSocketPair: {
        params: { pIdentity1: { nullable: true }, pIdentity2: { nullable: true } },
    },
    SteamAPI_ISteamNetworkingSockets_ConfigureConnectionLanes: {
        params: {
            pLanePriorities: { as: 'array', dir: 'in', count: 'param:nNumLanes', nullable: true },
            pLaneWeights: { as: 'array', dir: 'in', count: 'param:nNumLanes', nullable: true },
        },
    },
    SteamAPI_ISteamNetworkingSockets_GetAuthenticationStatus: {
        params: { pDetails: { nullable: true } },
    },
    SteamAPI_ISteamNetworkingSockets_ReceivedRelayAuthTicket: {
        // SteamDatagramRelayAuthTicket is defined in steamdatagram_tickets.h,
        // which is not part of the public SDK. NULL is allowed.
        params: { pOutParsedTicket: { as: 'nullOnly' } },
    },
    SteamAPI_ISteamNetworkingSockets_FindRelayAuthTicketForServer: {
        params: { pOutParsedTicket: { as: 'nullOnly' } },
    },
    SteamAPI_ISteamNetworkingSockets_GetGameCoordinatorServerLogin: {
        params: {
            pcbSignedBlob: { as: 'inout' },
            pBlob: { dir: 'out', count: 'inout:pcbSignedBlob' },
        },
    },
    SteamAPI_ISteamNetworkingSockets_GetCertificateRequest: {
        // Call with *pcbBlob = 0 and NULL to learn the size.
        params: {
            pcbBlob: { as: 'inout' },
            pBlob: { dir: 'out', count: 'inout:pcbBlob', nullable: true },
        },
    },
    SteamAPI_ISteamNetworkingSockets_ResetIdentity: {
        params: { pIdentity: { nullable: true } },
    },

    // --- ISteamNetworkingMessages -------------------------------------------
    SteamAPI_ISteamNetworkingMessages_GetSessionConnectionInfo: {
        params: { pConnectionInfo: { nullable: true }, pQuickStatus: { nullable: true } },
    },

    // --- ISteamNetworkingUtils ----------------------------------------------
    SteamAPI_ISteamNetworkingUtils_GetPOPList: {
        params: { list: { as: 'array', dir: 'out', count: 'param:nListSz', nullable: true } },
    },
    SteamAPI_ISteamNetworkingUtils_GetRelayNetworkStatus: {
        params: { pDetails: { nullable: true } },
    },
    SteamAPI_ISteamNetworkingUtils_GetPingToDataCenter: {
        params: { pViaRelayPoP: { nullable: true } },
    },
    SteamAPI_ISteamNetworkingUtils_GetConfigValue: {
        // Pass NULL with *cbResult = 0 to learn the required size.
        params: { pResult: { nullable: true } },
    },
    SteamAPI_ISteamNetworkingUtils_SetGlobalConfigValuePtr: {
        status: 'unsupported',
        reason: 'Stores a raw native pointer (usually a function pointer) inside Steam. JavaScript cannot provide one safely.',
    },
    SteamAPI_ISteamNetworkingUtils_SetConfigValue: {
        status: 'manual',
        reason: 'pArg points to an int32, int64, float, string or pointer depending on eDataType.',
    },

    // --- struct methods -----------------------------------------------------
    SteamAPI_SteamNetworkingIPAddr_SetIPv6: {
        params: { ipv6: { as: 'array', dir: 'in', count: 'fixed:16' } },
    },
    SteamAPI_SteamNetworkingIdentity_GetGenericBytes: {
        ret: { kind: 'bytes', len: 'cbLen' },
    },
    SteamAPI_SteamNetworkingConfigValue_t_SetPtr: {
        status: 'unsupported',
        reason: 'Stores a raw native pointer in the struct.',
    },
    SteamAPI_SteamNetworkingConfigValue_t_SetString: {
        status: 'unsupported',
        reason: 'Stores a pointer to the string, which would dangle once the call returns. Use SteamNetworkingUtils.SetGlobalConfigValueString / SetConnectionConfigValueString instead.',
    },
    SteamAPI_SteamNetworkingMessage_t_Release: {
        status: 'unsupported',
        reason: 'Received messages are copied into JavaScript and released immediately, so there is nothing to release.',
    },
}

// Struct methods whose inline C++ implementation calls SteamNetworkingUtils().
// They crash on a null interface, so the generated code checks for Steam first.
export const structMethodsRequiringSteam = new Set([
    'SteamAPI_SteamNetworkingIPAddr_ToString',
    'SteamAPI_SteamNetworkingIPAddr_ParseString',
    'SteamAPI_SteamNetworkingIPAddr_GetFakeIPType',
    'SteamAPI_SteamNetworkingIPAddr_IsFakeIP',
    'SteamAPI_SteamNetworkingIdentity_ToString',
    'SteamAPI_SteamNetworkingIdentity_ParseString',
    'SteamAPI_SteamNetworkingIdentity_GetFakeIPType',
    'SteamAPI_SteamNetworkingIdentity_IsFakeIP',
])

// Parameter rules that apply to every method with a parameter of this name and type.
export const paramPatterns = [
    {
        // Every ISteamNetworkingSockets connect/listen call takes `int nOptions,
        // const SteamNetworkingConfigValue_t *pOptions` (count before pointer).
        match: (p) => p.name === 'pOptions' && p.record === 'SteamNetworkingConfigValue_t',
        apply: { as: 'structArray', dir: 'in', count: 'param:nOptions', nullable: true },
    },
]

// Whole interfaces that are not exposed, with the reason shown in the docs.
export const interfaceExclusions = {
    ISteamClient: 'Creates pipes, users and raw interface pointers. init() and the accessors below already do this, and steam_api.json declares no flat accessor for it.',
    ISteamMatchmakingServerListResponse: 'An interface your game implements to receive results. Pass a handler object to the matchmaking servers calls instead.',
    ISteamMatchmakingPingResponse: 'An interface your game implements to receive results. Pass a handler object to PingServer instead.',
    ISteamMatchmakingPlayersResponse: 'An interface your game implements to receive results. Pass a handler object to PlayerDetails instead.',
    ISteamMatchmakingRulesResponse: 'An interface your game implements to receive results. Pass a handler object to ServerRules instead.',
}

// Methods implemented by hand in src/sdk/manual.rs and lib/sdk/runtime.js.
// The generator wires their docs and dispatch and checks the list stays
// in sync with steam_api.json.
export const manualMethods = {
    SteamAPI_ISteamNetworkingMessages_ReceiveMessagesOnChannel: 'Returns copies of the received messages and releases the native ones.',
    SteamAPI_ISteamNetworkingSockets_ReceiveMessagesOnConnection: 'Returns copies of the received messages and releases the native ones.',
    SteamAPI_ISteamNetworkingSockets_ReceiveMessagesOnPollGroup: 'Returns copies of the received messages and releases the native ones.',
    SteamAPI_ISteamNetworkingSockets_SendMessages: 'Takes message descriptions and allocates the native messages itself.',
    SteamAPI_ISteamNetworkingUtils_SetConfigValue: 'pArg points to an int32, int64, float, string or pointer depending on eDataType.',
    SteamAPI_ISteamInput_EnableActionEventCallbacks: 'Takes a JavaScript handler instead of a function pointer; events are queued natively and delivered by the callback pump.',
}

// Methods that cannot be expressed from JavaScript, with the reason.
export const unsupportedMethods = {
    SteamAPI_ISteamNetworkingUtils_AllocateMessage: 'Returns a native message JavaScript cannot own. SteamNetworkingSockets.SendMessages allocates messages from the payloads you pass it.',
    SteamAPI_ISteamNetworkingSockets_ConnectP2PCustomSignaling: 'Requires a native ISteamNetworkingConnectionSignaling object implemented by the game.',
    SteamAPI_ISteamNetworkingSockets_ReceivedP2PCustomSignal: 'Requires a native ISteamNetworkingSignalingRecvContext object implemented by the game.',
    SteamAPI_ISteamNetworkingSockets_CreateFakeUDPPort: 'Returns a native ISteamNetworkingFakeUDPPort object.',
    SteamAPI_ISteamNetworkingUtils_SetDebugOutputFunction: 'Takes a native function pointer.',
    SteamAPI_ISteamNetworkingUtils_SetGlobalCallback_SteamNetConnectionStatusChanged: 'Takes a native function pointer. Subscribe with sdk.on(\'SteamNetConnectionStatusChangedCallback_t\') instead.',
    SteamAPI_ISteamNetworkingUtils_SetGlobalCallback_SteamNetAuthenticationStatusChanged: 'Takes a native function pointer. Subscribe with sdk.on(\'SteamNetAuthenticationStatus_t\') instead.',
    SteamAPI_ISteamNetworkingUtils_SetGlobalCallback_SteamRelayNetworkStatusChanged: 'Takes a native function pointer. Subscribe with sdk.on(\'SteamRelayNetworkStatus_t\') instead.',
    SteamAPI_ISteamNetworkingUtils_SetGlobalCallback_FakeIPResult: 'Takes a native function pointer. Subscribe with sdk.on(\'SteamNetworkingFakeIPResult_t\') instead.',
    SteamAPI_ISteamNetworkingUtils_SetGlobalCallback_MessagesSessionRequest: 'Takes a native function pointer. Subscribe with sdk.on(\'SteamNetworkingMessagesSessionRequest_t\') instead.',
    SteamAPI_ISteamNetworkingUtils_SetGlobalCallback_MessagesSessionFailed: 'Takes a native function pointer. Subscribe with sdk.on(\'SteamNetworkingMessagesSessionFailed_t\') instead.',
}

// ISteamMatchmakingServers needs native response objects (C++ vtables) for
// its request calls; until those are implemented the whole interface is
// listed as pending rather than half-exposed.
export const pendingInterfaces = {
    ISteamMatchmakingServers: 'Server browser requests report results through native response objects. Not implemented yet.',
}
