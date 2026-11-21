//! ISteamMatchmakingServers (the server browser).
//!
//! The SDK reports server-browser results by calling methods on C++ objects
//! the game implements (ISteamMatchmakingServerListResponse and friends).
//! Each object here is a `#[repr(C)]` struct whose first field points to a
//! static table of `extern "C"` functions. On every 64-bit target the addon
//! supports, that matches a C++ object with only virtual methods: `this` is
//! the first argument and the table holds the methods in declaration order.
//!
//! The functions only queue events; JavaScript calls the response handlers
//! on the next callback pump, as for other callbacks. JavaScript sees
//! requests and queries as opaque handles that are checked against the
//! registry below, so it can never pass Steam an arbitrary pointer.
#![allow(non_snake_case)]

use super::{js_bool, js_bytes, js_num, js_u64, js_undefined, pack, Args, Pipe};
use napi::{Env, Error, JsUnknown, Result};
use std::collections::{HashMap, HashSet};
use std::ffi::{c_char, c_void};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use steamworks::sys;

/// Pseudo callback id for server-browser events; lib/sdk/runtime.js uses the same value.
pub const SERVER_BROWSER_EVENT_ID: i32 = -2;

#[repr(C)]
struct ListVtable {
    server_responded: unsafe extern "C" fn(*mut Response, *mut c_void, i32),
    server_failed_to_respond: unsafe extern "C" fn(*mut Response, *mut c_void, i32),
    refresh_complete: unsafe extern "C" fn(*mut Response, *mut c_void, i32),
}

#[repr(C)]
struct PingVtable {
    server_responded: unsafe extern "C" fn(*mut Response, *mut sys::gameserveritem_t),
    server_failed_to_respond: unsafe extern "C" fn(*mut Response),
}

#[repr(C)]
struct PlayersVtable {
    add_player_to_list: unsafe extern "C" fn(*mut Response, *const c_char, i32, f32),
    players_failed_to_respond: unsafe extern "C" fn(*mut Response),
    players_refresh_complete: unsafe extern "C" fn(*mut Response),
}

#[repr(C)]
struct RulesVtable {
    rules_responded: unsafe extern "C" fn(*mut Response, *const c_char, *const c_char),
    rules_failed_to_respond: unsafe extern "C" fn(*mut Response),
    rules_refresh_complete: unsafe extern "C" fn(*mut Response),
}

/// The object Steam holds a pointer to. `vtable` must stay the first field.
#[repr(C)]
struct Response {
    vtable: *const c_void,
    token: u32,
}

static LIST_VTABLE: ListVtable = ListVtable {
    server_responded: list_server_responded,
    server_failed_to_respond: list_server_failed_to_respond,
    refresh_complete: list_refresh_complete,
};
static PING_VTABLE: PingVtable = PingVtable {
    server_responded: ping_server_responded,
    server_failed_to_respond: ping_server_failed_to_respond,
};
static PLAYERS_VTABLE: PlayersVtable = PlayersVtable {
    add_player_to_list: players_add_player_to_list,
    players_failed_to_respond,
    players_refresh_complete,
};
static RULES_VTABLE: RulesVtable = RulesVtable {
    rules_responded,
    rules_failed_to_respond,
    rules_refresh_complete,
};

struct Registry {
    /// HServerListRequest -> response object (lives until ReleaseRequest)
    lists: HashMap<usize, Box<Response>>,
    /// HServerQuery -> response object (lives until the query finishes)
    queries: HashMap<i32, Box<Response>>,
    /// Finished queries, freed on the next pump: Steam may still be inside
    /// the call that finished them. Boxed so the objects never move while
    /// Steam holds pointers to them.
    #[allow(clippy::vec_box)]
    finished: Vec<Box<Response>>,
    /// Tokens of queries that finished before they were registered (Steam
    /// answered inside PingServer/PlayerDetails/ServerRules itself).
    finished_early: HashSet<u32>,
}
// Response objects are only touched on the JavaScript main thread.
unsafe impl Send for Registry {}

lazy_static! {
    static ref REGISTRY: Mutex<Registry> = Mutex::new(Registry {
        lists: HashMap::new(),
        queries: HashMap::new(),
        finished: Vec::new(),
        finished_early: HashSet::new(),
    });
}
static NEXT_TOKEN: AtomicU32 = AtomicU32::new(1);

// Event layout (24 bytes, little endian), mirrored in lib/sdk/runtime.js:
//   0 u32 token, 4 u32 method, 8 u64 hRequest, 16 i32 arg, 20 f32 time
// Strings and gameserveritem_t bytes travel in the event's extras.
fn push(token: u32, method: u32, request: usize, arg: i32, time: f32, extras: Vec<super::Extra>) {
    let mut data = Vec::with_capacity(24);
    data.extend_from_slice(&token.to_le_bytes());
    data.extend_from_slice(&method.to_le_bytes());
    data.extend_from_slice(&(request as u64).to_le_bytes());
    data.extend_from_slice(&arg.to_le_bytes());
    data.extend_from_slice(&time.to_le_bytes());
    super::push_callback_with_extras(Pipe::Client, SERVER_BROWSER_EVENT_ID, data, extras);
}

/// Mark a query's response object finished; it is freed on the next pump.
fn finish_query(this: *mut Response) {
    let mut registry = REGISTRY.lock().unwrap();
    let key = registry
        .queries
        .iter()
        .find(|(_, r)| std::ptr::eq(&***r, this))
        .map(|(k, _)| *k);
    match key.and_then(|k| registry.queries.remove(&k)) {
        Some(r) => registry.finished.push(r),
        None => {
            let token = unsafe { (*this).token };
            registry.finished_early.insert(token);
        }
    }
}

unsafe extern "C" fn list_server_responded(this: *mut Response, request: *mut c_void, server: i32) {
    push((*this).token, 0, request as usize, server, 0.0, Vec::new());
}
unsafe extern "C" fn list_server_failed_to_respond(
    this: *mut Response,
    request: *mut c_void,
    server: i32,
) {
    push((*this).token, 1, request as usize, server, 0.0, Vec::new());
}
unsafe extern "C" fn list_refresh_complete(
    this: *mut Response,
    request: *mut c_void,
    response: i32,
) {
    push(
        (*this).token,
        2,
        request as usize,
        response,
        0.0,
        Vec::new(),
    );
}
unsafe extern "C" fn ping_server_responded(
    this: *mut Response,
    server: *mut sys::gameserveritem_t,
) {
    let bytes = if server.is_null() {
        Vec::new()
    } else {
        std::slice::from_raw_parts(
            server as *const u8,
            std::mem::size_of::<sys::gameserveritem_t>(),
        )
        .to_vec()
    };
    push(
        (*this).token,
        0,
        0,
        0,
        0.0,
        vec![super::Extra::Bytes(bytes)],
    );
    finish_query(this);
}
unsafe extern "C" fn ping_server_failed_to_respond(this: *mut Response) {
    push((*this).token, 1, 0, 0, 0.0, Vec::new());
    finish_query(this);
}
unsafe extern "C" fn players_add_player_to_list(
    this: *mut Response,
    name: *const c_char,
    score: i32,
    time: f32,
) {
    push(
        (*this).token,
        0,
        0,
        score,
        time,
        vec![super::extra_cstr(name as *const c_void)],
    );
}
unsafe extern "C" fn players_failed_to_respond(this: *mut Response) {
    push((*this).token, 1, 0, 0, 0.0, Vec::new());
    finish_query(this);
}
unsafe extern "C" fn players_refresh_complete(this: *mut Response) {
    push((*this).token, 2, 0, 0, 0.0, Vec::new());
    finish_query(this);
}
unsafe extern "C" fn rules_responded(
    this: *mut Response,
    rule: *const c_char,
    value: *const c_char,
) {
    push(
        (*this).token,
        0,
        0,
        0,
        0.0,
        vec![
            super::extra_cstr(rule as *const c_void),
            super::extra_cstr(value as *const c_void),
        ],
    );
}
unsafe extern "C" fn rules_failed_to_respond(this: *mut Response) {
    push((*this).token, 1, 0, 0, 0.0, Vec::new());
    finish_query(this);
}
unsafe extern "C" fn rules_refresh_complete(this: *mut Response) {
    push((*this).token, 2, 0, 0, 0.0, Vec::new());
    finish_query(this);
}

/// Free finished query objects. Called before events are handed to JavaScript.
pub(crate) fn collect_finished() {
    REGISTRY.lock().unwrap().finished.clear();
}

/// Forget every object (Steam was shut down, so it holds no pointers to them).
pub(crate) fn clear() {
    let mut registry = REGISTRY.lock().unwrap();
    registry.lists.clear();
    registry.queries.clear();
    registry.finished.clear();
    registry.finished_early.clear();
}

fn new_response(vtable: *const c_void) -> Box<Response> {
    Box::new(Response {
        vtable,
        token: NEXT_TOKEN.fetch_add(1, Ordering::Relaxed),
    })
}

mod ffi {
    use super::{sys, Response};
    use std::ffi::c_void;

    extern "C" {
        pub fn SteamAPI_ISteamMatchmakingServers_RequestInternetServerList(
            self_: *mut c_void,
            iApp: u32,
            ppchFilters: *mut *mut sys::MatchMakingKeyValuePair_t,
            nFilters: u32,
            pRequestServersResponse: *mut Response,
        ) -> *mut c_void;
        pub fn SteamAPI_ISteamMatchmakingServers_RequestLANServerList(
            self_: *mut c_void,
            iApp: u32,
            pRequestServersResponse: *mut Response,
        ) -> *mut c_void;
        pub fn SteamAPI_ISteamMatchmakingServers_RequestFriendsServerList(
            self_: *mut c_void,
            iApp: u32,
            ppchFilters: *mut *mut sys::MatchMakingKeyValuePair_t,
            nFilters: u32,
            pRequestServersResponse: *mut Response,
        ) -> *mut c_void;
        pub fn SteamAPI_ISteamMatchmakingServers_RequestFavoritesServerList(
            self_: *mut c_void,
            iApp: u32,
            ppchFilters: *mut *mut sys::MatchMakingKeyValuePair_t,
            nFilters: u32,
            pRequestServersResponse: *mut Response,
        ) -> *mut c_void;
        pub fn SteamAPI_ISteamMatchmakingServers_RequestHistoryServerList(
            self_: *mut c_void,
            iApp: u32,
            ppchFilters: *mut *mut sys::MatchMakingKeyValuePair_t,
            nFilters: u32,
            pRequestServersResponse: *mut Response,
        ) -> *mut c_void;
        pub fn SteamAPI_ISteamMatchmakingServers_RequestSpectatorServerList(
            self_: *mut c_void,
            iApp: u32,
            ppchFilters: *mut *mut sys::MatchMakingKeyValuePair_t,
            nFilters: u32,
            pRequestServersResponse: *mut Response,
        ) -> *mut c_void;
        pub fn SteamAPI_ISteamMatchmakingServers_ReleaseRequest(
            self_: *mut c_void,
            hServerListRequest: *mut c_void,
        );
        pub fn SteamAPI_ISteamMatchmakingServers_GetServerDetails(
            self_: *mut c_void,
            hRequest: *mut c_void,
            iServer: i32,
        ) -> *mut sys::gameserveritem_t;
        pub fn SteamAPI_ISteamMatchmakingServers_CancelQuery(
            self_: *mut c_void,
            hRequest: *mut c_void,
        );
        pub fn SteamAPI_ISteamMatchmakingServers_RefreshQuery(
            self_: *mut c_void,
            hRequest: *mut c_void,
        );
        pub fn SteamAPI_ISteamMatchmakingServers_IsRefreshing(
            self_: *mut c_void,
            hRequest: *mut c_void,
        ) -> bool;
        pub fn SteamAPI_ISteamMatchmakingServers_GetServerCount(
            self_: *mut c_void,
            hRequest: *mut c_void,
        ) -> i32;
        pub fn SteamAPI_ISteamMatchmakingServers_RefreshServer(
            self_: *mut c_void,
            hRequest: *mut c_void,
            iServer: i32,
        );
        pub fn SteamAPI_ISteamMatchmakingServers_PingServer(
            self_: *mut c_void,
            unIP: u32,
            usPort: u16,
            pRequestServersResponse: *mut Response,
        ) -> i32;
        pub fn SteamAPI_ISteamMatchmakingServers_PlayerDetails(
            self_: *mut c_void,
            unIP: u32,
            usPort: u16,
            pRequestServersResponse: *mut Response,
        ) -> i32;
        pub fn SteamAPI_ISteamMatchmakingServers_ServerRules(
            self_: *mut c_void,
            unIP: u32,
            usPort: u16,
            pRequestServersResponse: *mut Response,
        ) -> i32;
        pub fn SteamAPI_ISteamMatchmakingServers_CancelServerQuery(
            self_: *mut c_void,
            hServerQuery: i32,
        );
    }
}

type ListRequestFn = unsafe extern "C" fn(
    *mut c_void,
    u32,
    *mut *mut sys::MatchMakingKeyValuePair_t,
    u32,
    *mut Response,
) -> *mut c_void;

/// Args: `[iApp, filters (MatchMakingKeyValuePair_t bytes[]), nFilters]`.
/// Returns `[hRequest, token]`.
unsafe fn request_list(
    env: &Env,
    iface: *mut c_void,
    a: &Args,
    call: ListRequestFn,
) -> Result<JsUnknown> {
    let app = a.int(0, "iApp", 0, u32::MAX as i128)? as u32;
    let count = a.int(2, "nFilters", 0, 1024)? as usize;
    let items = if a.is_nullish(1) {
        None
    } else {
        Some(a.items(1, "ppchFilters")?)
    };
    let available = items.as_ref().map_or(0, |i| i.len());
    if available < count {
        return Err(Error::from_reason(format!(
            "{}: ppchFilters has {available} entries but nFilters is {count}",
            a.method()
        )));
    }
    let mut filters: Vec<sys::MatchMakingKeyValuePair_t> = Vec::with_capacity(count);
    if let Some(items) = &items {
        for i in 0..count {
            filters.push(items.struct_val(i, &format!("ppchFilters[{i}]"))?);
        }
    }
    let mut pointers: Vec<*mut sys::MatchMakingKeyValuePair_t> =
        filters.iter_mut().map(|f| f as *mut _).collect();
    let mut response = new_response(&LIST_VTABLE as *const ListVtable as *const c_void);
    let token = response.token;
    let request = call(
        iface,
        app,
        if count == 0 {
            std::ptr::null_mut()
        } else {
            pointers.as_mut_ptr()
        },
        count as u32,
        &mut *response,
    );
    if request.is_null() {
        return pack(env, vec![js_u64(env, 0)?, js_num(env, token as f64)?]);
    }
    REGISTRY
        .lock()
        .unwrap()
        .lists
        .insert(request as usize, response);
    pack(
        env,
        vec![js_u64(env, request as u64)?, js_num(env, token as f64)?],
    )
}

/// The HServerListRequest at argument `i`, checked against live requests.
fn list_handle(a: &Args, i: usize) -> Result<*mut c_void> {
    let value = a.int(i, "hRequest", 0, u64::MAX as i128)? as usize;
    if !REGISTRY.lock().unwrap().lists.contains_key(&value) {
        return Err(Error::from_reason(format!(
            "{}: hRequest is not a live HServerListRequest (already released?)",
            a.method()
        )));
    }
    Ok(value as *mut c_void)
}

macro_rules! list_request {
    ($name:ident) => {
        pub unsafe fn $name(
            env: &Env,
            iface: *mut c_void,
            _pipe: Pipe,
            a: &Args,
        ) -> Result<JsUnknown> {
            request_list(env, iface, a, ffi::$name)
        }
    };
}

list_request!(SteamAPI_ISteamMatchmakingServers_RequestInternetServerList);
list_request!(SteamAPI_ISteamMatchmakingServers_RequestFriendsServerList);
list_request!(SteamAPI_ISteamMatchmakingServers_RequestFavoritesServerList);
list_request!(SteamAPI_ISteamMatchmakingServers_RequestHistoryServerList);
list_request!(SteamAPI_ISteamMatchmakingServers_RequestSpectatorServerList);

/// Args: `[iApp]`. Returns `[hRequest, token]`.
pub unsafe fn SteamAPI_ISteamMatchmakingServers_RequestLANServerList(
    env: &Env,
    iface: *mut c_void,
    _pipe: Pipe,
    a: &Args,
) -> Result<JsUnknown> {
    let app = a.int(0, "iApp", 0, u32::MAX as i128)? as u32;
    let mut response = new_response(&LIST_VTABLE as *const ListVtable as *const c_void);
    let token = response.token;
    let request =
        ffi::SteamAPI_ISteamMatchmakingServers_RequestLANServerList(iface, app, &mut *response);
    if !request.is_null() {
        REGISTRY
            .lock()
            .unwrap()
            .lists
            .insert(request as usize, response);
    }
    pack(
        env,
        vec![js_u64(env, request as u64)?, js_num(env, token as f64)?],
    )
}

pub unsafe fn SteamAPI_ISteamMatchmakingServers_ReleaseRequest(
    env: &Env,
    iface: *mut c_void,
    _pipe: Pipe,
    a: &Args,
) -> Result<JsUnknown> {
    let request = list_handle(a, 0)?;
    ffi::SteamAPI_ISteamMatchmakingServers_ReleaseRequest(iface, request);
    // Steam no longer references the response object.
    REGISTRY.lock().unwrap().lists.remove(&(request as usize));
    js_undefined(env)
}

pub unsafe fn SteamAPI_ISteamMatchmakingServers_GetServerDetails(
    env: &Env,
    iface: *mut c_void,
    _pipe: Pipe,
    a: &Args,
) -> Result<JsUnknown> {
    let request = list_handle(a, 0)?;
    let server = a.int(1, "iServer", i32::MIN as i128, i32::MAX as i128)? as i32;
    let item = ffi::SteamAPI_ISteamMatchmakingServers_GetServerDetails(iface, request, server);
    js_bytes(
        env,
        item as *const c_void,
        std::mem::size_of::<sys::gameserveritem_t>(),
    )
}

pub unsafe fn SteamAPI_ISteamMatchmakingServers_CancelQuery(
    env: &Env,
    iface: *mut c_void,
    _pipe: Pipe,
    a: &Args,
) -> Result<JsUnknown> {
    ffi::SteamAPI_ISteamMatchmakingServers_CancelQuery(iface, list_handle(a, 0)?);
    js_undefined(env)
}

pub unsafe fn SteamAPI_ISteamMatchmakingServers_RefreshQuery(
    env: &Env,
    iface: *mut c_void,
    _pipe: Pipe,
    a: &Args,
) -> Result<JsUnknown> {
    ffi::SteamAPI_ISteamMatchmakingServers_RefreshQuery(iface, list_handle(a, 0)?);
    js_undefined(env)
}

pub unsafe fn SteamAPI_ISteamMatchmakingServers_IsRefreshing(
    env: &Env,
    iface: *mut c_void,
    _pipe: Pipe,
    a: &Args,
) -> Result<JsUnknown> {
    js_bool(
        env,
        ffi::SteamAPI_ISteamMatchmakingServers_IsRefreshing(iface, list_handle(a, 0)?),
    )
}

pub unsafe fn SteamAPI_ISteamMatchmakingServers_GetServerCount(
    env: &Env,
    iface: *mut c_void,
    _pipe: Pipe,
    a: &Args,
) -> Result<JsUnknown> {
    let n = ffi::SteamAPI_ISteamMatchmakingServers_GetServerCount(iface, list_handle(a, 0)?);
    js_num(env, n as f64)
}

pub unsafe fn SteamAPI_ISteamMatchmakingServers_RefreshServer(
    env: &Env,
    iface: *mut c_void,
    _pipe: Pipe,
    a: &Args,
) -> Result<JsUnknown> {
    let request = list_handle(a, 0)?;
    let server = a.int(1, "iServer", i32::MIN as i128, i32::MAX as i128)? as i32;
    ffi::SteamAPI_ISteamMatchmakingServers_RefreshServer(iface, request, server);
    js_undefined(env)
}

type QueryFn = unsafe extern "C" fn(*mut c_void, u32, u16, *mut Response) -> i32;

/// Args: `[unIP, usPort]`. Returns `[hServerQuery, token]`.
unsafe fn query(
    env: &Env,
    iface: *mut c_void,
    a: &Args,
    vtable: *const c_void,
    call: QueryFn,
) -> Result<JsUnknown> {
    let ip = a.int(0, "unIP", 0, u32::MAX as i128)? as u32;
    let port = a.int(1, "usPort", 0, u16::MAX as i128)? as u16;
    let mut response = new_response(vtable);
    let token = response.token;
    let handle = call(iface, ip, port, &mut *response);
    let mut registry = REGISTRY.lock().unwrap();
    // HSERVERQUERY_INVALID (-1): Steam will not call the object.
    if handle == -1 || registry.finished_early.remove(&token) {
        registry.finished.push(response);
    } else {
        registry.queries.insert(handle, response);
    }
    pack(
        env,
        vec![js_num(env, handle as f64)?, js_num(env, token as f64)?],
    )
}

pub unsafe fn SteamAPI_ISteamMatchmakingServers_PingServer(
    env: &Env,
    iface: *mut c_void,
    _pipe: Pipe,
    a: &Args,
) -> Result<JsUnknown> {
    query(
        env,
        iface,
        a,
        &PING_VTABLE as *const PingVtable as *const c_void,
        ffi::SteamAPI_ISteamMatchmakingServers_PingServer,
    )
}

pub unsafe fn SteamAPI_ISteamMatchmakingServers_PlayerDetails(
    env: &Env,
    iface: *mut c_void,
    _pipe: Pipe,
    a: &Args,
) -> Result<JsUnknown> {
    query(
        env,
        iface,
        a,
        &PLAYERS_VTABLE as *const PlayersVtable as *const c_void,
        ffi::SteamAPI_ISteamMatchmakingServers_PlayerDetails,
    )
}

pub unsafe fn SteamAPI_ISteamMatchmakingServers_ServerRules(
    env: &Env,
    iface: *mut c_void,
    _pipe: Pipe,
    a: &Args,
) -> Result<JsUnknown> {
    query(
        env,
        iface,
        a,
        &RULES_VTABLE as *const RulesVtable as *const c_void,
        ffi::SteamAPI_ISteamMatchmakingServers_ServerRules,
    )
}

pub unsafe fn SteamAPI_ISteamMatchmakingServers_CancelServerQuery(
    env: &Env,
    iface: *mut c_void,
    _pipe: Pipe,
    a: &Args,
) -> Result<JsUnknown> {
    let handle = a.int(0, "hServerQuery", i32::MIN as i128, i32::MAX as i128)? as i32;
    let mut registry = REGISTRY.lock().unwrap();
    let Some(response) = registry.queries.remove(&handle) else {
        return Err(Error::from_reason(format!(
            "{}: hServerQuery is not a running query",
            a.method()
        )));
    };
    drop(registry);
    ffi::SteamAPI_ISteamMatchmakingServers_CancelServerQuery(iface, handle);
    REGISTRY.lock().unwrap().finished.push(response);
    js_undefined(env)
}
