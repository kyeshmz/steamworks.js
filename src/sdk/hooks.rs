//! SDK methods that register a native function pointer.
//!
//! JavaScript keeps the handler. Steam gets an `extern "C"` function that
//! copies what it is given into the event queue under a pseudo callback id
//! (mirrored in lib/sdk/runtime.js); the callback pump then calls the
//! handler on the main thread. Some of these (the networking debug output)
//! can be called from Steam's own threads, which the queue's mutex allows.
#![allow(non_snake_case)]

use super::{extra_cstr, js_bool, js_undefined, push_callback_with_extras, Args, Pipe};
use napi::{Env, JsUnknown, Result};
use std::ffi::{c_char, c_void};
use steamworks::sys;

pub const WARNING_HOOK_EVENT_ID: i32 = -3;
pub const DEBUG_OUTPUT_EVENT_ID: i32 = -4;
/// Global networking callbacks use ids GLOBAL_CALLBACK_EVENT_BASE - slot.
pub const GLOBAL_CALLBACK_EVENT_BASE: i32 = -10;

mod ffi {
    use super::{c_char, c_void, sys};

    pub type Hook = Option<unsafe extern "C" fn(i32, *const c_char)>;

    extern "C" {
        pub fn SteamAPI_ISteamUtils_SetWarningMessageHook(self_: *mut c_void, pFunction: Hook);
        pub fn SteamAPI_ISteamNetworkingUtils_SetDebugOutputFunction(
            self_: *mut c_void,
            eDetailLevel: i32,
            pfnFunc: Hook,
        );
        pub fn SteamAPI_ISteamNetworkingUtils_SetGlobalCallback_SteamNetConnectionStatusChanged(
            self_: *mut c_void,
            fnCallback: Option<
                unsafe extern "C" fn(*mut sys::SteamNetConnectionStatusChangedCallback_t),
            >,
        ) -> bool;
        pub fn SteamAPI_ISteamNetworkingUtils_SetGlobalCallback_SteamNetAuthenticationStatusChanged(
            self_: *mut c_void,
            fnCallback: Option<unsafe extern "C" fn(*mut sys::SteamNetAuthenticationStatus_t)>,
        ) -> bool;
        pub fn SteamAPI_ISteamNetworkingUtils_SetGlobalCallback_SteamRelayNetworkStatusChanged(
            self_: *mut c_void,
            fnCallback: Option<unsafe extern "C" fn(*mut sys::SteamRelayNetworkStatus_t)>,
        ) -> bool;
        pub fn SteamAPI_ISteamNetworkingUtils_SetGlobalCallback_FakeIPResult(
            self_: *mut c_void,
            fnCallback: Option<
                unsafe extern "C" fn(*mut super::super::extra::SteamNetworkingFakeIPResult_t),
            >,
        ) -> bool;
        pub fn SteamAPI_ISteamNetworkingUtils_SetGlobalCallback_MessagesSessionRequest(
            self_: *mut c_void,
            fnCallback: Option<
                unsafe extern "C" fn(*mut sys::SteamNetworkingMessagesSessionRequest_t),
            >,
        ) -> bool;
        pub fn SteamAPI_ISteamNetworkingUtils_SetGlobalCallback_MessagesSessionFailed(
            self_: *mut c_void,
            fnCallback: Option<
                unsafe extern "C" fn(*mut sys::SteamNetworkingMessagesSessionFailed_t),
            >,
        ) -> bool;
    }
}

unsafe extern "C" fn warning_hook(severity: i32, text: *const c_char) {
    push_callback_with_extras(
        Pipe::Client,
        WARNING_HOOK_EVENT_ID,
        severity.to_le_bytes().to_vec(),
        vec![extra_cstr(text as *const c_void)],
    );
}

unsafe extern "C" fn debug_output(kind: i32, message: *const c_char) {
    push_callback_with_extras(
        Pipe::Client,
        DEBUG_OUTPUT_EVENT_ID,
        kind.to_le_bytes().to_vec(),
        vec![extra_cstr(message as *const c_void)],
    );
}

/// Args: `[enabled]`.
pub unsafe fn SteamAPI_ISteamUtils_SetWarningMessageHook(
    env: &Env,
    iface: *mut c_void,
    _pipe: Pipe,
    a: &Args,
) -> Result<JsUnknown> {
    let enabled = a.bool(0, "enabled")?;
    ffi::SteamAPI_ISteamUtils_SetWarningMessageHook(
        iface,
        if enabled { Some(warning_hook) } else { None },
    );
    js_undefined(env)
}

/// Args: `[eDetailLevel, enabled]`.
pub unsafe fn SteamAPI_ISteamNetworkingUtils_SetDebugOutputFunction(
    env: &Env,
    iface: *mut c_void,
    _pipe: Pipe,
    a: &Args,
) -> Result<JsUnknown> {
    let level = a.int(0, "eDetailLevel", i32::MIN as i128, u32::MAX as i128)? as i32;
    let enabled = a.bool(1, "enabled")?;
    ffi::SteamAPI_ISteamNetworkingUtils_SetDebugOutputFunction(
        iface,
        level,
        if enabled { Some(debug_output) } else { None },
    );
    js_undefined(env)
}

/// A trampoline that copies the struct Steam passes, and the setter that
/// installs (args `[true]`) or removes (`[false]`) it.
macro_rules! global_callback {
    ($setter:ident, $trampoline:ident, $ty:ty, $slot:expr) => {
        unsafe extern "C" fn $trampoline(info: *mut $ty) {
            if info.is_null() {
                return;
            }
            let bytes =
                std::slice::from_raw_parts(info as *const u8, std::mem::size_of::<$ty>()).to_vec();
            push_callback_with_extras(
                Pipe::Client,
                GLOBAL_CALLBACK_EVENT_BASE - $slot,
                bytes,
                Vec::new(),
            );
        }

        pub unsafe fn $setter(
            env: &Env,
            iface: *mut c_void,
            _pipe: Pipe,
            a: &Args,
        ) -> Result<JsUnknown> {
            let enabled = a.bool(0, "enabled")?;
            let ok = ffi::$setter(iface, if enabled { Some($trampoline) } else { None });
            js_bool(env, ok)
        }
    };
}

global_callback!(
    SteamAPI_ISteamNetworkingUtils_SetGlobalCallback_SteamNetConnectionStatusChanged,
    on_connection_status_changed,
    sys::SteamNetConnectionStatusChangedCallback_t,
    0
);
global_callback!(
    SteamAPI_ISteamNetworkingUtils_SetGlobalCallback_SteamNetAuthenticationStatusChanged,
    on_authentication_status_changed,
    sys::SteamNetAuthenticationStatus_t,
    1
);
global_callback!(
    SteamAPI_ISteamNetworkingUtils_SetGlobalCallback_SteamRelayNetworkStatusChanged,
    on_relay_network_status_changed,
    sys::SteamRelayNetworkStatus_t,
    2
);
global_callback!(
    SteamAPI_ISteamNetworkingUtils_SetGlobalCallback_FakeIPResult,
    on_fake_ip_result,
    super::extra::SteamNetworkingFakeIPResult_t,
    3
);
global_callback!(
    SteamAPI_ISteamNetworkingUtils_SetGlobalCallback_MessagesSessionRequest,
    on_messages_session_request,
    sys::SteamNetworkingMessagesSessionRequest_t,
    4
);
global_callback!(
    SteamAPI_ISteamNetworkingUtils_SetGlobalCallback_MessagesSessionFailed,
    on_messages_session_failed,
    sys::SteamNetworkingMessagesSessionFailed_t,
    5
);
