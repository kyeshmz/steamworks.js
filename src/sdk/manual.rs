//! Flat API methods whose parameters cannot be generated mechanically.
//! Each function has the signature of a generated method; the generator
//! routes to it by flat name (see `manualMethods` in scripts/sdk/overrides.mjs)
//! and lib/sdk/runtime.js provides the matching JavaScript wrapper.
#![allow(non_snake_case)]

use super::{js_bytes, js_i64, js_struct, pack, unavailable, Args, Pipe};

// ISteamMatchmakingServers lives in its own module; the generated dispatch
// reaches every hand-written method through this one.
pub use super::hooks::{
    SteamAPI_ISteamNetworkingUtils_SetDebugOutputFunction,
    SteamAPI_ISteamNetworkingUtils_SetGlobalCallback_FakeIPResult,
    SteamAPI_ISteamNetworkingUtils_SetGlobalCallback_MessagesSessionFailed,
    SteamAPI_ISteamNetworkingUtils_SetGlobalCallback_MessagesSessionRequest,
    SteamAPI_ISteamNetworkingUtils_SetGlobalCallback_SteamNetAuthenticationStatusChanged,
    SteamAPI_ISteamNetworkingUtils_SetGlobalCallback_SteamNetConnectionStatusChanged,
    SteamAPI_ISteamNetworkingUtils_SetGlobalCallback_SteamRelayNetworkStatusChanged,
    SteamAPI_ISteamUtils_SetWarningMessageHook,
};
pub use super::servers::{
    SteamAPI_ISteamMatchmakingServers_CancelQuery,
    SteamAPI_ISteamMatchmakingServers_CancelServerQuery,
    SteamAPI_ISteamMatchmakingServers_GetServerCount,
    SteamAPI_ISteamMatchmakingServers_GetServerDetails,
    SteamAPI_ISteamMatchmakingServers_IsRefreshing, SteamAPI_ISteamMatchmakingServers_PingServer,
    SteamAPI_ISteamMatchmakingServers_PlayerDetails,
    SteamAPI_ISteamMatchmakingServers_RefreshQuery,
    SteamAPI_ISteamMatchmakingServers_RefreshServer,
    SteamAPI_ISteamMatchmakingServers_ReleaseRequest,
    SteamAPI_ISteamMatchmakingServers_RequestFavoritesServerList,
    SteamAPI_ISteamMatchmakingServers_RequestFriendsServerList,
    SteamAPI_ISteamMatchmakingServers_RequestHistoryServerList,
    SteamAPI_ISteamMatchmakingServers_RequestInternetServerList,
    SteamAPI_ISteamMatchmakingServers_RequestLANServerList,
    SteamAPI_ISteamMatchmakingServers_RequestSpectatorServerList,
    SteamAPI_ISteamMatchmakingServers_ServerRules,
};
use napi::{Env, Error, JsUnknown, Result};
use std::ffi::{c_void, CString};
use steamworks::sys;

type Msg = sys::SteamNetworkingMessage_t;

mod ffi {
    use super::Msg;
    use std::ffi::c_void;

    extern "C" {
        pub fn SteamAPI_SteamNetworkingUtils_SteamAPI_v004() -> *mut c_void;
        pub fn SteamAPI_ISteamNetworkingUtils_AllocateMessage(
            self_: *mut c_void,
            cb: i32,
        ) -> *mut Msg;
        pub fn SteamAPI_SteamNetworkingMessage_t_Release(self_: *mut Msg);
        pub fn SteamAPI_ISteamNetworkingMessages_ReceiveMessagesOnChannel(
            self_: *mut c_void,
            nLocalChannel: i32,
            ppOutMessages: *mut *mut Msg,
            nMaxMessages: i32,
        ) -> i32;
        pub fn SteamAPI_ISteamNetworkingSockets_ReceiveMessagesOnConnection(
            self_: *mut c_void,
            hConn: u32,
            ppOutMessages: *mut *mut Msg,
            nMaxMessages: i32,
        ) -> i32;
        pub fn SteamAPI_ISteamNetworkingSockets_ReceiveMessagesOnPollGroup(
            self_: *mut c_void,
            hPollGroup: u32,
            ppOutMessages: *mut *mut Msg,
            nMaxMessages: i32,
        ) -> i32;
        pub fn SteamAPI_ISteamNetworkingSockets_SendMessages(
            self_: *mut c_void,
            nMessages: i32,
            pMessages: *const *mut Msg,
            pOutMessageNumberOrResult: *mut i64,
        );
        pub fn SteamAPI_ISteamNetworkingSockets_CreateFakeUDPPort(
            self_: *mut c_void,
            idxFakeServerPort: i32,
        ) -> *mut c_void;
        pub fn SteamAPI_ISteamNetworkingFakeUDPPort_ReceiveMessages(
            self_: *mut c_void,
            ppOutMessages: *mut *mut Msg,
            nMaxMessages: i32,
        ) -> i32;
        pub fn SteamAPI_ISteamInput_EnableActionEventCallbacks(
            self_: *mut c_void,
            pCallback: Option<unsafe extern "C" fn(*mut steamworks::sys::SteamInputActionEvent_t)>,
        );
        pub fn SteamAPI_ISteamNetworkingUtils_SetConfigValue(
            self_: *mut c_void,
            eValue: i32,
            eScopeType: i32,
            scopeObj: isize,
            eDataType: i32,
            pArg: *const c_void,
        ) -> bool;
    }
}

const MAX_BATCH: i128 = 65536;

/// Copy each message (struct bytes and payload) and release the native one.
/// Returns `[result, [structBytes, payload, ...]]`.
unsafe fn take_messages(env: &Env, received: i32, messages: &mut [*mut Msg]) -> Result<JsUnknown> {
    let count = received.max(0) as usize;
    let mut copies = Vec::with_capacity(count * 2);
    for &msg in messages.iter().take(count) {
        if msg.is_null() {
            continue;
        }
        copies.push(js_struct(env, &*msg)?);
        copies.push(js_bytes(
            env,
            (*msg).m_pData,
            (*msg).m_cbSize.max(0) as usize,
        )?);
        ffi::SteamAPI_SteamNetworkingMessage_t_Release(msg);
    }
    pack(
        env,
        vec![super::js_num(env, received as f64)?, pack(env, copies)?],
    )
}

fn batch(a: &Args, i: usize, name: &str) -> Result<i32> {
    Ok(a.int(i, name, 0, MAX_BATCH)? as i32)
}

pub unsafe fn SteamAPI_ISteamNetworkingMessages_ReceiveMessagesOnChannel(
    env: &Env,
    iface: *mut c_void,
    _pipe: Pipe,
    a: &Args,
) -> Result<JsUnknown> {
    let channel = a.int(0, "nLocalChannel", i32::MIN as i128, i32::MAX as i128)? as i32;
    let max = batch(a, 2, "nMaxMessages")?;
    let mut messages = vec![std::ptr::null_mut(); max as usize];
    let n = ffi::SteamAPI_ISteamNetworkingMessages_ReceiveMessagesOnChannel(
        iface,
        channel,
        messages.as_mut_ptr(),
        max,
    );
    take_messages(env, n, &mut messages)
}

pub unsafe fn SteamAPI_ISteamNetworkingSockets_ReceiveMessagesOnConnection(
    env: &Env,
    iface: *mut c_void,
    _pipe: Pipe,
    a: &Args,
) -> Result<JsUnknown> {
    let conn = a.int(0, "hConn", 0, u32::MAX as i128)? as u32;
    let max = batch(a, 2, "nMaxMessages")?;
    let mut messages = vec![std::ptr::null_mut(); max as usize];
    let n = ffi::SteamAPI_ISteamNetworkingSockets_ReceiveMessagesOnConnection(
        iface,
        conn,
        messages.as_mut_ptr(),
        max,
    );
    take_messages(env, n, &mut messages)
}

pub unsafe fn SteamAPI_ISteamNetworkingSockets_ReceiveMessagesOnPollGroup(
    env: &Env,
    iface: *mut c_void,
    _pipe: Pipe,
    a: &Args,
) -> Result<JsUnknown> {
    let group = a.int(0, "hPollGroup", 0, u32::MAX as i128)? as u32;
    let max = batch(a, 2, "nMaxMessages")?;
    let mut messages = vec![std::ptr::null_mut(); max as usize];
    let n = ffi::SteamAPI_ISteamNetworkingSockets_ReceiveMessagesOnPollGroup(
        iface,
        group,
        messages.as_mut_ptr(),
        max,
    );
    take_messages(env, n, &mut messages)
}

/// Args: `[nMessages, [struct0, payload0, struct1, payload1, ...]]`.
/// Steam takes ownership of the messages allocated here.
pub unsafe fn SteamAPI_ISteamNetworkingSockets_SendMessages(
    env: &Env,
    iface: *mut c_void,
    _pipe: Pipe,
    a: &Args,
) -> Result<JsUnknown> {
    let n = batch(a, 0, "nMessages")? as usize;
    let items = a.items(1, "pMessages")?;
    if items.len() != n * 2 {
        return Err(Error::from_reason(format!(
            "{}: pMessages must hold nMessages entries",
            a.method()
        )));
    }
    let utils = ffi::SteamAPI_SteamNetworkingUtils_SteamAPI_v004();
    if utils.is_null() {
        return Err(Error::from_reason("SteamNetworkingUtils() returned NULL"));
    }
    // Validate everything before allocating, so a bad entry leaks nothing.
    let mut templates = Vec::with_capacity(n);
    for i in 0..n {
        let template: Msg = items.struct_val(i * 2, &format!("pMessages[{i}]"))?;
        let payload_len = items.byte_len(i * 2 + 1, &format!("pMessages[{i}].data"))?;
        let payload = items.mem(
            i * 2 + 1,
            &format!("pMessages[{i}].data"),
            payload_len as i128,
            true,
        )?;
        templates.push((template, payload, payload_len));
    }
    let mut messages = Vec::with_capacity(n);
    for (template, payload, len) in templates {
        let msg = ffi::SteamAPI_ISteamNetworkingUtils_AllocateMessage(utils, len as i32);
        if msg.is_null() {
            for m in messages {
                ffi::SteamAPI_SteamNetworkingMessage_t_Release(m);
            }
            return Err(Error::from_reason("AllocateMessage returned NULL"));
        }
        if len > 0 {
            std::ptr::copy_nonoverlapping(payload as *const u8, (*msg).m_pData as *mut u8, len);
        }
        (*msg).m_conn = template.m_conn;
        (*msg).m_identityPeer = template.m_identityPeer;
        (*msg).m_nChannel = template.m_nChannel;
        (*msg).m_nFlags = template.m_nFlags;
        (*msg).m_nUserData = template.m_nUserData;
        (*msg).m_idxLane = template.m_idxLane;
        messages.push(msg);
    }
    let mut results = vec![0i64; n];
    ffi::SteamAPI_ISteamNetworkingSockets_SendMessages(
        iface,
        n as i32,
        messages.as_ptr(),
        results.as_mut_ptr(),
    );
    let values = results
        .into_iter()
        .map(|r| js_i64(env, r))
        .collect::<Result<Vec<_>>>()?;
    pack(env, vec![pack(env, values)?])
}

/// Args: `[eValue, eScopeType, scopeObj, eDataType, value]` where value is a
/// number (Int32/Float), number or bigint (Int64) or string (String).
pub unsafe fn SteamAPI_ISteamNetworkingUtils_SetConfigValue(
    env: &Env,
    iface: *mut c_void,
    _pipe: Pipe,
    a: &Args,
) -> Result<JsUnknown> {
    let e_value = a.int(0, "eValue", i32::MIN as i128, u32::MAX as i128)? as i32;
    let e_scope = a.int(1, "eScopeType", i32::MIN as i128, u32::MAX as i128)? as i32;
    let scope_obj = a.int(2, "scopeObj", i64::MIN as i128, i64::MAX as i128)? as isize;
    let e_type = a.int(3, "eDataType", i32::MIN as i128, u32::MAX as i128)? as i32;
    let ok = match e_type {
        // k_ESteamNetworkingConfig_Int32
        1 => {
            let v = a.int(4, "pArg", i32::MIN as i128, i32::MAX as i128)? as i32;
            ffi::SteamAPI_ISteamNetworkingUtils_SetConfigValue(
                iface,
                e_value,
                e_scope,
                scope_obj,
                e_type,
                &v as *const i32 as *const c_void,
            )
        }
        // k_ESteamNetworkingConfig_Int64
        2 => {
            let v = a.int(4, "pArg", i64::MIN as i128, i64::MAX as i128)? as i64;
            ffi::SteamAPI_ISteamNetworkingUtils_SetConfigValue(
                iface,
                e_value,
                e_scope,
                scope_obj,
                e_type,
                &v as *const i64 as *const c_void,
            )
        }
        // k_ESteamNetworkingConfig_Float
        3 => {
            let v = a.float(4, "pArg")? as f32;
            ffi::SteamAPI_ISteamNetworkingUtils_SetConfigValue(
                iface,
                e_value,
                e_scope,
                scope_obj,
                e_type,
                &v as *const f32 as *const c_void,
            )
        }
        // k_ESteamNetworkingConfig_String: pArg is the string itself
        4 => {
            let v: CString = a.cstr(4, "pArg")?;
            ffi::SteamAPI_ISteamNetworkingUtils_SetConfigValue(
                iface,
                e_value,
                e_scope,
                scope_obj,
                e_type,
                v.as_ptr() as *const c_void,
            )
        }
        _ => {
            return Err(unavailable(
                a.method(),
                "only Int32, Int64, Float and String config values can be set from JavaScript",
            ))
        }
    };
    super::js_bool(env, ok)
}

/// Pseudo callback id for SteamInputActionEvent_t; lib/sdk/runtime.js uses the same value.
pub const INPUT_ACTION_EVENT_ID: i32 = -1;

unsafe extern "C" fn on_input_action_event(event: *mut sys::SteamInputActionEvent_t) {
    if event.is_null() {
        return;
    }
    let size = std::mem::size_of::<sys::SteamInputActionEvent_t>();
    let bytes = std::slice::from_raw_parts(event as *const u8, size).to_vec();
    super::push_callback(Pipe::Client, INPUT_ACTION_EVENT_ID, bytes);
}

/// Args: `[enabled]`. JavaScript keeps the handler; Steam gets a native
/// function that queues each event for the callback pump.
pub unsafe fn SteamAPI_ISteamInput_EnableActionEventCallbacks(
    env: &Env,
    iface: *mut c_void,
    _pipe: Pipe,
    a: &Args,
) -> Result<JsUnknown> {
    let enabled = a.bool(0, "enabled")?;
    ffi::SteamAPI_ISteamInput_EnableActionEventCallbacks(
        iface,
        if enabled {
            Some(on_input_action_event)
        } else {
            None
        },
    );
    super::js_undefined(env)
}

/// Args: `[idxFakeServerPort]`. Returns the port object's handle (0 on failure).
pub unsafe fn SteamAPI_ISteamNetworkingSockets_CreateFakeUDPPort(
    env: &Env,
    iface: *mut c_void,
    _pipe: Pipe,
    a: &Args,
) -> Result<JsUnknown> {
    let idx = a.int(0, "idxFakeServerPort", i32::MIN as i128, i32::MAX as i128)? as i32;
    let port = ffi::SteamAPI_ISteamNetworkingSockets_CreateFakeUDPPort(iface, idx);
    if !port.is_null() {
        super::register_object(port);
    }
    super::js_u64(env, port as u64)
}

/// Args: `[ppOutMessages (unused), nMaxMessages]`; `iface` is the port object.
pub unsafe fn SteamAPI_ISteamNetworkingFakeUDPPort_ReceiveMessages(
    env: &Env,
    iface: *mut c_void,
    _pipe: Pipe,
    a: &Args,
) -> Result<JsUnknown> {
    let max = batch(a, 1, "nMaxMessages")?;
    let mut messages = vec![std::ptr::null_mut(); max as usize];
    let n = ffi::SteamAPI_ISteamNetworkingFakeUDPPort_ReceiveMessages(
        iface,
        messages.as_mut_ptr(),
        max,
    );
    take_messages(env, n, &mut messages)
}
