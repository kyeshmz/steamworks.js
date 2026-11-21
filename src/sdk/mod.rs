//! Runtime for the 1:1 Steamworks SDK layer.
//!
//! `generated.rs` (written by `scripts/sdk/generate.mjs`) contains one
//! function per flat API method, the interface accessors, struct layouts and
//! callback tables. This module holds what those functions share: argument
//! decoding, JavaScript value construction, the callback/call-result queue and
//! game server lifetime. JavaScript reaches it through the `sdk*` exports
//! below, wrapped by `lib/sdk/runtime.js`.

pub mod extra;
// Formatting is the generator's job; `cargo fmt` would make `--check` fail.
#[rustfmt::skip]
mod generated;
mod manual;

use napi::bindgen_prelude::BigInt;
use napi::{sys as nsys, Env, Error, JsObject, JsUnknown, NapiRaw, Result};
use napi_derive::napi;
use std::collections::HashSet;
use std::ffi::{c_char, c_void, CStr, CString};
use std::ptr;
use std::sync::Mutex;
use steamworks::sys;

/// Which Steam pipe an interface (and its callbacks) belongs to.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Pipe {
    /// SteamAPI_Init: the logged-in user.
    Client,
    /// SteamGameServer_Init.
    Server,
    /// Works with either (SteamNetworkingUtils).
    Global,
}

pub struct Accessor {
    pub name: &'static str,
    pub interface: u16,
    pub pipe: Pipe,
    pub get: unsafe extern "C" fn() -> *mut c_void,
}

pub struct MethodInfo {
    pub name: &'static str,
    /// Index into the interface table, or `u16::MAX` for struct methods.
    pub interface: u16,
    /// Struct methods that call into Steam need it initialized.
    pub requires_steam: bool,
}

// ---------------------------------------------------------------------------
// state

struct GameServer {
    _server: steamworks::Server,
    client: steamworks::Client<steamworks::ServerManager>,
}
// Only used from the JavaScript main thread.
unsafe impl Send for GameServer {}

pub enum Extra {
    Str(Option<String>),
    Bytes(Vec<u8>),
}

enum Event {
    Callback {
        pipe: Pipe,
        id: i32,
        data: Vec<u8>,
        extras: Vec<Extra>,
    },
    CallResult {
        pipe: Pipe,
        handle: u64,
        id: i32,
        data: Vec<u8>,
        failed: bool,
    },
}

lazy_static! {
    static ref GAME_SERVER: Mutex<Option<GameServer>> = Mutex::new(None);
    static ref EVENTS: Mutex<Vec<Event>> = Mutex::new(Vec::new());
    static ref SUBSCRIBED: Mutex<HashSet<i32>> = Mutex::new(HashSet::new());
}

fn observe(pipe: Pipe, id: i32, data: *const c_void, size: usize) {
    if !SUBSCRIBED.lock().unwrap().contains(&id) || data.is_null() {
        return;
    }
    // The callback memory is only valid during this call: copy the struct and
    // anything its pointer fields refer to.
    let bytes = unsafe { std::slice::from_raw_parts(data as *const u8, size) }.to_vec();
    let extras = unsafe { generated::callback_extras(id, data, size) };
    EVENTS.lock().unwrap().push(Event::Callback {
        pipe,
        id,
        data: bytes,
        extras,
    });
}

/// Queue an event that did not come through the callback dispatcher (for
/// example SteamInputActionEvent_t, which Steam passes to a function pointer).
pub(crate) fn push_callback(pipe: Pipe, id: i32, data: Vec<u8>) {
    EVENTS.lock().unwrap().push(Event::Callback {
        pipe,
        id,
        data,
        extras: Vec::new(),
    });
}

/// Called by `init()` once the client exists.
pub(crate) fn attach_client(client: &steamworks::Client) {
    EVENTS.lock().unwrap().clear();
    client.set_raw_callback_observer(Some(Box::new(|id, data, size| {
        observe(Pipe::Client, id, data, size)
    })));
}

pub(crate) fn run_server_callbacks() {
    let server = GAME_SERVER.lock().unwrap();
    if let Some(server) = server.as_ref() {
        server.client.run_callbacks();
    }
}

fn has_server() -> bool {
    GAME_SERVER.lock().unwrap().is_some()
}

fn pipe_ready(pipe: Pipe) -> bool {
    match pipe {
        Pipe::Client => crate::client::has_client(),
        Pipe::Server => has_server(),
        Pipe::Global => crate::client::has_client() || has_server(),
    }
}

/// Deliver the result of `handle` to the event queue.
pub(crate) fn watch_call_result(pipe: Pipe, handle: u64) {
    if handle == 0 {
        return;
    }
    let handler: steamworks::RawCallResultHandler = Box::new(move |id, data, failed| {
        EVENTS.lock().unwrap().push(Event::CallResult {
            pipe,
            handle,
            id,
            data: data.to_vec(),
            failed,
        });
    });
    match pipe {
        Pipe::Server => {
            if let Some(server) = GAME_SERVER.lock().unwrap().as_ref() {
                server.client.register_raw_call_result(handle, handler);
            }
        }
        _ => {
            if crate::client::has_client() {
                crate::client::get_client().register_raw_call_result(handle, handler);
            } else if let Some(server) = GAME_SERVER.lock().unwrap().as_ref() {
                server.client.register_raw_call_result(handle, handler);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// JavaScript entry points (wrapped by lib/sdk/runtime.js; not part of client.d.ts)

#[napi(js_name = "sdkCall", skip_typescript)]
pub fn sdk_call(env: Env, method: u32, accessor: u32, args: JsObject) -> Result<JsUnknown> {
    let info = generated::METHODS
        .get(method as usize)
        .ok_or_else(|| Error::from_reason(format!("unknown SDK method #{method}")))?;
    let args = Args::new(&env, &args, info.name)?;
    let (iface, pipe) = if info.interface == u16::MAX {
        if info.requires_steam && !pipe_ready(Pipe::Global) {
            return Err(Error::from_reason(format!(
                "{} needs Steam: call init() or initGameServer() first",
                info.name
            )));
        }
        (ptr::null_mut(), Pipe::Global)
    } else {
        let acc = generated::ACCESSORS
            .get(accessor as usize)
            .filter(|a| a.interface == info.interface)
            .ok_or_else(|| {
                Error::from_reason(format!("{}: wrong interface accessor", info.name))
            })?;
        if !pipe_ready(acc.pipe) {
            return Err(Error::from_reason(match acc.pipe {
                Pipe::Server => format!("{}() needs initGameServer() first", acc.name),
                _ => format!("{}() needs init() first", acc.name),
            }));
        }
        let iface = unsafe { (acc.get)() };
        if iface.is_null() {
            return Err(Error::from_reason(format!("{}() returned NULL", acc.name)));
        }
        let pipe = if acc.pipe == Pipe::Global {
            if crate::client::has_client() {
                Pipe::Client
            } else {
                Pipe::Server
            }
        } else {
            acc.pipe
        };
        (iface, pipe)
    };
    unsafe { generated::call(&env, method, iface, pipe, &args) }
}

/// Start or stop copying callbacks with this id into the event queue.
#[napi(js_name = "sdkSubscribe", skip_typescript)]
pub fn sdk_subscribe(id: i32, enabled: bool) {
    let mut set = SUBSCRIBED.lock().unwrap();
    if enabled {
        set.insert(id);
    } else {
        set.remove(&id);
    }
}

/// Deliver the result of an arbitrary SteamAPICall_t (e.g. from an out parameter).
#[napi(js_name = "sdkWatchCallResult", skip_typescript)]
pub fn sdk_watch_call_result(handle: BigInt, server: bool) -> Result<()> {
    let (_, value, lossless) = handle.get_u64();
    if !lossless {
        return Err(Error::from_reason("handle must be a uint64 bigint"));
    }
    watch_call_result(if server { Pipe::Server } else { Pipe::Client }, value);
    Ok(())
}

/// Drain the queue: `[kind, pipe, id, handle, failed, data, extras][]` where
/// kind 0 = callback, 1 = call result; pipe 0 = client, 1 = game server.
#[napi(js_name = "sdkTakeEvents", skip_typescript)]
pub fn sdk_take_events(env: Env) -> Result<JsUnknown> {
    let events = std::mem::take(&mut *EVENTS.lock().unwrap());
    let mut out = env.create_array_with_length(events.len())?;
    for (i, event) in events.into_iter().enumerate() {
        let mut row = env.create_array_with_length(7)?;
        match event {
            Event::Callback {
                pipe,
                id,
                data,
                extras,
            } => {
                row.set_element(0, env.create_uint32(0)?)?;
                row.set_element(1, env.create_uint32((pipe == Pipe::Server) as u32)?)?;
                row.set_element(2, env.create_int32(id)?)?;
                row.set_element(3, env.get_null()?)?;
                row.set_element(4, env.get_boolean(false)?)?;
                row.set_element(5, env.create_buffer_with_data(data)?.into_raw())?;
                let mut list = env.create_array_with_length(extras.len())?;
                for (j, extra) in extras.into_iter().enumerate() {
                    match extra {
                        Extra::Str(Some(s)) => {
                            list.set_element(j as u32, env.create_string_from_std(s)?)?
                        }
                        Extra::Str(None) => list.set_element(j as u32, env.get_null()?)?,
                        Extra::Bytes(b) => {
                            list.set_element(j as u32, env.create_buffer_with_data(b)?.into_raw())?
                        }
                    }
                }
                row.set_element(6, list)?;
            }
            Event::CallResult {
                pipe,
                handle,
                id,
                data,
                failed,
            } => {
                row.set_element(0, env.create_uint32(1)?)?;
                row.set_element(1, env.create_uint32((pipe == Pipe::Server) as u32)?)?;
                row.set_element(2, env.create_int32(id)?)?;
                row.set_element(3, env.create_bigint_from_u64(handle)?.into_unknown()?)?;
                row.set_element(4, env.get_boolean(failed)?)?;
                row.set_element(5, env.create_buffer_with_data(data)?.into_raw())?;
                row.set_element(6, env.get_null()?)?;
            }
        }
        out.set_element(i as u32, row)?;
    }
    Ok(out.into_unknown())
}

/// `{ [struct]: [size, offsets[]] }` for this platform's packing.
#[napi(js_name = "sdkLayouts", skip_typescript)]
pub fn sdk_layouts(env: Env) -> Result<JsObject> {
    let mut out = env.create_object()?;
    for (name, size, offsets) in generated::layouts() {
        let mut row = env.create_array_with_length(2)?;
        row.set_element(0, env.create_uint32(size as u32)?)?;
        let mut list = env.create_array_with_length(offsets.len())?;
        for (i, off) in offsets.iter().enumerate() {
            list.set_element(i as u32, env.create_uint32(*off as u32)?)?;
        }
        row.set_element(1, list)?;
        out.set_named_property(name, row)?;
    }
    Ok(out)
}

/// `[clientInitialized, gameServerInitialized]`
#[napi(js_name = "sdkState", skip_typescript)]
pub fn sdk_state() -> Vec<bool> {
    vec![crate::client::has_client(), has_server()]
}

/// SteamGameServer_Init. Arguments follow the SDK:
/// `unIP` (host order), `usGamePort`, `usQueryPort`, `eServerMode`
/// (EServerMode: 1 NoAuthentication, 2 Authentication, 3 AuthenticationAndSecure),
/// `pchVersionString`.
#[napi(js_name = "sdkInitGameServer", skip_typescript)]
pub fn sdk_init_game_server(
    un_ip: u32,
    us_game_port: u32,
    us_query_port: u32,
    e_server_mode: u32,
    pch_version_string: String,
) -> Result<()> {
    let mode = match e_server_mode {
        1 => steamworks::ServerMode::NoAuthentication,
        2 => steamworks::ServerMode::Authentication,
        3 => steamworks::ServerMode::AuthenticationAndSecure,
        _ => {
            return Err(Error::from_reason(
                "eServerMode must be 1, 2 or 3 (EServerMode)",
            ))
        }
    };
    let port = |v: u32, name: &str| -> Result<u16> {
        u16::try_from(v).map_err(|_| Error::from_reason(format!("{name} must fit in uint16")))
    };
    if has_server() {
        sdk_shutdown_game_server();
    }
    let (server, client) = steamworks::Server::init(
        std::net::Ipv4Addr::from(un_ip),
        port(us_game_port, "usGamePort")?,
        port(us_query_port, "usQueryPort")?,
        mode,
        &pch_version_string,
    )
    .map_err(|e| Error::from_reason(e.to_string()))?;
    client.set_raw_callback_observer(Some(Box::new(|id, data, size| {
        observe(Pipe::Server, id, data, size)
    })));
    *GAME_SERVER.lock().unwrap() = Some(GameServer {
        _server: server,
        client,
    });
    Ok(())
}

/// SteamGameServer_Shutdown.
#[napi(js_name = "sdkShutdownGameServer", skip_typescript)]
pub fn sdk_shutdown_game_server() {
    let server = GAME_SERVER.lock().unwrap().take();
    drop(server);
}

// ---------------------------------------------------------------------------
// argument decoding

/// The JavaScript arguments of one call, in C parameter order.
pub struct Args {
    env: nsys::napi_env,
    values: Vec<nsys::napi_value>,
    method: &'static str,
}

/// Owns the strings behind a `SteamParamStringArray_t`.
pub struct StrArray {
    _strings: Vec<CString>,
    _pointers: Vec<*const c_char>,
    pub raw: sys::SteamParamStringArray_t,
}

/// Owns the strings behind a NULL-terminated `const char **`.
pub struct CStrList {
    _strings: Vec<CString>,
    pub pointers: Vec<*const c_char>,
}

/// A char buffer Steam writes a string into.
pub struct OutString {
    buf: Vec<u8>,
}

const MAX_OUT_STRING: usize = 64 * 1024 * 1024;

impl OutString {
    pub fn new(cap: i128, name: &str, method: &str) -> Result<Self> {
        if cap < 0 || cap as usize > MAX_OUT_STRING {
            return Err(Error::from_reason(format!(
                "{method}: buffer size for {name} must be between 0 and {MAX_OUT_STRING}"
            )));
        }
        Ok(OutString {
            buf: vec![0u8; cap as usize],
        })
    }
    /// NULL when the capacity is 0 (Steam's "query the size" convention).
    pub fn ptr(&mut self) -> *mut c_void {
        if self.buf.is_empty() {
            ptr::null_mut()
        } else {
            self.buf.as_mut_ptr() as *mut c_void
        }
    }
    pub fn to_js(&self, env: &Env) -> Result<JsUnknown> {
        let end = self
            .buf
            .iter()
            .position(|&b| b == 0)
            .unwrap_or(self.buf.len());
        Ok(env
            .create_string_from_std(String::from_utf8_lossy(&self.buf[..end]).into_owned())?
            .into_unknown())
    }
}

macro_rules! check {
    ($e:expr) => {{
        let status = $e;
        if status != nsys::Status::napi_ok {
            return Err(Error::from_reason(format!("N-API call failed ({status})")));
        }
    }};
}

impl Args {
    fn new(env: &Env, array: &JsObject, method: &'static str) -> Result<Self> {
        let raw_env = env.raw();
        let raw = unsafe { array.raw() };
        let mut is_array = false;
        unsafe { check!(nsys::napi_is_array(raw_env, raw, &mut is_array)) };
        if !is_array {
            return Err(Error::from_reason(format!(
                "{method}: arguments must be an array"
            )));
        }
        let mut len = 0u32;
        unsafe { check!(nsys::napi_get_array_length(raw_env, raw, &mut len)) };
        let mut values = Vec::with_capacity(len as usize);
        for i in 0..len {
            let mut v = ptr::null_mut();
            unsafe { check!(nsys::napi_get_element(raw_env, raw, i, &mut v)) };
            values.push(v);
        }
        Ok(Args {
            env: raw_env,
            values,
            method,
        })
    }

    pub fn method(&self) -> &'static str {
        self.method
    }

    fn err(&self, name: &str, msg: &str) -> Error {
        Error::new(
            napi::Status::InvalidArg,
            format!("{}: {} {}", self.method, name, msg),
        )
    }

    fn type_of(&self, i: usize) -> i32 {
        let Some(&v) = self.values.get(i) else {
            return nsys::ValueType::napi_undefined;
        };
        let mut t = 0;
        unsafe { nsys::napi_typeof(self.env, v, &mut t) };
        t
    }

    pub fn is_nullish(&self, i: usize) -> bool {
        matches!(
            self.type_of(i),
            nsys::ValueType::napi_undefined | nsys::ValueType::napi_null
        )
    }

    pub fn bool(&self, i: usize, name: &str) -> Result<bool> {
        if self.type_of(i) != nsys::ValueType::napi_boolean {
            return Err(self.err(name, "must be a boolean"));
        }
        let mut b = false;
        unsafe { check!(nsys::napi_get_value_bool(self.env, self.values[i], &mut b)) };
        Ok(b)
    }

    /// An integer within `[lo, hi]` from a Number (safe integer) or a BigInt.
    pub fn int(&self, i: usize, name: &str, lo: i128, hi: i128) -> Result<i128> {
        let v: i128 = match self.type_of(i) {
            nsys::ValueType::napi_number => {
                let mut f = 0f64;
                unsafe {
                    check!(nsys::napi_get_value_double(
                        self.env,
                        self.values[i],
                        &mut f
                    ))
                };
                if !f.is_finite() || f.fract() != 0.0 || f.abs() > 9_007_199_254_740_991.0 {
                    return Err(self.err(name, "must be an integer (use a bigint above 2^53)"));
                }
                f as i128
            }
            nsys::ValueType::napi_bigint => {
                let mut signed = 0i64;
                let mut lossless = false;
                unsafe {
                    check!(nsys::napi_get_value_bigint_int64(
                        self.env,
                        self.values[i],
                        &mut signed,
                        &mut lossless
                    ))
                };
                if lossless {
                    signed as i128
                } else {
                    let mut unsigned = 0u64;
                    unsafe {
                        check!(nsys::napi_get_value_bigint_uint64(
                            self.env,
                            self.values[i],
                            &mut unsigned,
                            &mut lossless
                        ))
                    };
                    if !lossless {
                        return Err(self.err(name, "does not fit in 64 bits"));
                    }
                    unsigned as i128
                }
            }
            _ => return Err(self.err(name, "must be a number or bigint")),
        };
        if v < lo || v > hi {
            return Err(self.err(name, &format!("must be between {lo} and {hi}")));
        }
        Ok(v)
    }

    pub fn float(&self, i: usize, name: &str) -> Result<f64> {
        if self.type_of(i) != nsys::ValueType::napi_number {
            return Err(self.err(name, "must be a number"));
        }
        let mut f = 0f64;
        unsafe {
            check!(nsys::napi_get_value_double(
                self.env,
                self.values[i],
                &mut f
            ))
        };
        Ok(f)
    }

    fn string(&self, i: usize, name: &str) -> Result<String> {
        if self.type_of(i) != nsys::ValueType::napi_string {
            return Err(self.err(name, "must be a string"));
        }
        let mut len = 0usize;
        unsafe {
            check!(nsys::napi_get_value_string_utf8(
                self.env,
                self.values[i],
                ptr::null_mut(),
                0,
                &mut len
            ))
        };
        let mut buf = vec![0u8; len + 1];
        let mut written = 0usize;
        unsafe {
            check!(nsys::napi_get_value_string_utf8(
                self.env,
                self.values[i],
                buf.as_mut_ptr() as *mut c_char,
                buf.len(),
                &mut written
            ))
        };
        buf.truncate(written);
        String::from_utf8(buf).map_err(|_| self.err(name, "is not valid UTF-8"))
    }

    pub fn cstr(&self, i: usize, name: &str) -> Result<CString> {
        CString::new(self.string(i, name)?)
            .map_err(|_| self.err(name, "must not contain NUL characters"))
    }

    pub fn cstr_opt(&self, i: usize, name: &str) -> Result<Option<CString>> {
        if self.is_nullish(i) {
            return Ok(None);
        }
        self.cstr(i, name).map(Some)
    }

    /// Pointer to the memory of a TypedArray, Buffer or ArrayBuffer holding at
    /// least `min_bytes`. NULL for null/undefined when `nullable`.
    pub fn mem(
        &self,
        i: usize,
        name: &str,
        min_bytes: i128,
        nullable: bool,
    ) -> Result<*mut c_void> {
        if self.is_nullish(i) {
            if nullable {
                return Ok(ptr::null_mut());
            }
            return Err(self.err(name, "is required"));
        }
        if min_bytes < 0 {
            return Err(self.err(name, "size must not be negative"));
        }
        let v = self.values[i];
        let (data, len) = unsafe { self.memory_of(v) }.ok_or_else(|| {
            self.err(
                name,
                "must be a TypedArray, Buffer, ArrayBuffer or SDK struct",
            )
        })?;
        if (len as i128) < min_bytes {
            return Err(self.err(
                name,
                &format!("holds {len} bytes but the call needs {min_bytes}"),
            ));
        }
        // A zero-length view may report a dangling pointer; Steam gets NULL.
        if len == 0 {
            return Ok(ptr::null_mut());
        }
        Ok(data)
    }

    unsafe fn memory_of(&self, v: nsys::napi_value) -> Option<(*mut c_void, usize)> {
        let mut is = false;
        nsys::napi_is_typedarray(self.env, v, &mut is);
        if is {
            let mut kind = 0;
            let mut length = 0usize;
            let mut data = ptr::null_mut();
            let mut buffer = ptr::null_mut();
            let mut offset = 0usize;
            if nsys::napi_get_typedarray_info(
                self.env,
                v,
                &mut kind,
                &mut length,
                &mut data,
                &mut buffer,
                &mut offset,
            ) != nsys::Status::napi_ok
            {
                return None;
            }
            let elem = match kind {
                nsys::TypedarrayType::int8_array
                | nsys::TypedarrayType::uint8_array
                | nsys::TypedarrayType::uint8_clamped_array => 1,
                nsys::TypedarrayType::int16_array | nsys::TypedarrayType::uint16_array => 2,
                nsys::TypedarrayType::int32_array
                | nsys::TypedarrayType::uint32_array
                | nsys::TypedarrayType::float32_array => 4,
                _ => 8,
            };
            return Some((data, length * elem));
        }
        nsys::napi_is_arraybuffer(self.env, v, &mut is);
        if is {
            let mut data = ptr::null_mut();
            let mut length = 0usize;
            if nsys::napi_get_arraybuffer_info(self.env, v, &mut data, &mut length)
                != nsys::Status::napi_ok
            {
                return None;
            }
            return Some((data, length));
        }
        // SDK struct instances carry their bytes in `buffer`.
        let mut key = ptr::null_mut();
        nsys::napi_create_string_utf8(self.env, c"buffer".as_ptr(), 6, &mut key);
        let mut inner = ptr::null_mut();
        if nsys::napi_get_property(self.env, v, key, &mut inner) != nsys::Status::napi_ok {
            return None;
        }
        nsys::napi_is_typedarray(self.env, inner, &mut is);
        if is {
            return self.memory_of(inner);
        }
        None
    }

    pub fn len(&self) -> usize {
        self.values.len()
    }

    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    /// The elements of the array argument `i`, decoded like top-level arguments.
    pub fn items(&self, i: usize, name: &str) -> Result<Args> {
        let v = *self
            .values
            .get(i)
            .ok_or_else(|| self.err(name, "is required"))?;
        let mut is_array = false;
        unsafe { check!(nsys::napi_is_array(self.env, v, &mut is_array)) };
        if !is_array {
            return Err(self.err(name, "must be an array"));
        }
        let mut len = 0u32;
        unsafe { check!(nsys::napi_get_array_length(self.env, v, &mut len)) };
        let mut values = Vec::with_capacity(len as usize);
        for j in 0..len {
            let mut item = ptr::null_mut();
            unsafe { check!(nsys::napi_get_element(self.env, v, j, &mut item)) };
            values.push(item);
        }
        Ok(Args {
            env: self.env,
            values,
            method: self.method,
        })
    }

    /// Byte length of a memory argument (0 for null/undefined).
    pub fn byte_len(&self, i: usize, name: &str) -> Result<usize> {
        if self.is_nullish(i) {
            return Ok(0);
        }
        unsafe { self.memory_of(self.values[i]) }
            .map(|(_, len)| len)
            .ok_or_else(|| self.err(name, "must be a TypedArray, Buffer or ArrayBuffer"))
    }

    /// A struct passed by value, read from a struct instance or bytes.
    pub fn struct_val<T>(&self, i: usize, name: &str) -> Result<T> {
        let p = self.mem(i, name, std::mem::size_of::<T>() as i128, false)?;
        Ok(unsafe { ptr::read_unaligned(p as *const T) })
    }

    pub fn str_array(&self, i: usize, name: &str) -> Result<Option<Box<StrArray>>> {
        let Some(strings) = self.string_list(i, name)? else {
            return Ok(None);
        };
        let pointers: Vec<*const c_char> = strings.iter().map(|s| s.as_ptr()).collect();
        let mut sa = Box::new(StrArray {
            raw: sys::SteamParamStringArray_t {
                m_ppStrings: ptr::null_mut(),
                m_nNumStrings: pointers.len() as i32,
            },
            _strings: strings,
            _pointers: pointers,
        });
        sa.raw.m_ppStrings = sa._pointers.as_mut_ptr();
        Ok(Some(sa))
    }

    pub fn cstr_list(&self, i: usize, name: &str) -> Result<Option<CStrList>> {
        let Some(strings) = self.string_list(i, name)? else {
            return Ok(None);
        };
        let mut pointers: Vec<*const c_char> = strings.iter().map(|s| s.as_ptr()).collect();
        pointers.push(ptr::null());
        Ok(Some(CStrList {
            _strings: strings,
            pointers,
        }))
    }

    fn string_list(&self, i: usize, name: &str) -> Result<Option<Vec<CString>>> {
        if self.is_nullish(i) {
            return Ok(None);
        }
        let v = self.values[i];
        let mut is_array = false;
        unsafe { check!(nsys::napi_is_array(self.env, v, &mut is_array)) };
        if !is_array {
            return Err(self.err(name, "must be an array of strings"));
        }
        let mut len = 0u32;
        unsafe { check!(nsys::napi_get_array_length(self.env, v, &mut len)) };
        let mut items = Vec::new();
        for j in 0..len {
            let mut item = ptr::null_mut();
            unsafe { check!(nsys::napi_get_element(self.env, v, j, &mut item)) };
            items.push(item);
        }
        let sub = Args {
            env: self.env,
            values: items,
            method: self.method,
        };
        (0..len as usize)
            .map(|j| sub.cstr(j, &format!("{name}[{j}]")))
            .collect::<Result<Vec<_>>>()
            .map(Some)
    }
}

// ---------------------------------------------------------------------------
// JavaScript values

pub fn js_bool(env: &Env, v: bool) -> Result<JsUnknown> {
    Ok(env.get_boolean(v)?.into_unknown())
}

pub fn js_num(env: &Env, v: f64) -> Result<JsUnknown> {
    Ok(env.create_double(v)?.into_unknown())
}

pub fn js_u64(env: &Env, v: u64) -> Result<JsUnknown> {
    env.create_bigint_from_u64(v)?.into_unknown()
}

pub fn js_i64(env: &Env, v: i64) -> Result<JsUnknown> {
    env.create_bigint_from_i64(v)?.into_unknown()
}

pub fn js_undefined(env: &Env) -> Result<JsUnknown> {
    Ok(env.get_undefined()?.into_unknown())
}

/// Copy a C string returned by Steam (NULL becomes `null`).
///
/// # Safety
/// `p` is NULL or points to a NUL-terminated string.
pub unsafe fn js_cstr(env: &Env, p: *const c_char) -> Result<JsUnknown> {
    if p.is_null() {
        return Ok(env.get_null()?.into_unknown());
    }
    let s = CStr::from_ptr(p).to_string_lossy().into_owned();
    Ok(env.create_string_from_std(s)?.into_unknown())
}

/// Copy `len` bytes at `p` into a Buffer (NULL becomes `null`).
///
/// # Safety
/// `p` is NULL or valid for reads of `len` bytes.
pub unsafe fn js_bytes(env: &Env, p: *const c_void, len: usize) -> Result<JsUnknown> {
    if p.is_null() {
        return Ok(env.get_null()?.into_unknown());
    }
    let bytes = std::slice::from_raw_parts(p as *const u8, len).to_vec();
    Ok(env
        .create_buffer_with_data(bytes)?
        .into_raw()
        .into_unknown())
}

/// Bytes of a struct returned by value.
pub fn js_struct<T>(env: &Env, v: &T) -> Result<JsUnknown> {
    unsafe {
        js_bytes(
            env,
            v as *const T as *const c_void,
            std::mem::size_of::<T>(),
        )
    }
}

/// `[return value?, ...out parameters]`
pub fn pack(env: &Env, values: Vec<JsUnknown>) -> Result<JsUnknown> {
    let mut arr = env.create_array_with_length(values.len())?;
    for (i, v) in values.into_iter().enumerate() {
        arr.set_element(i as u32, v)?;
    }
    Ok(arr.into_unknown())
}

/// Read a pointer field at `offset` of a callback struct of `size` bytes.
///
/// # Safety
/// `data` is valid for reads of `size` bytes.
pub unsafe fn read_ptr(data: *const c_void, size: usize, offset: usize) -> *const c_void {
    if offset + std::mem::size_of::<usize>() > size {
        return ptr::null();
    }
    ptr::read_unaligned((data as *const u8).add(offset) as *const *const c_void)
}

/// # Safety
/// `data` is valid for reads of `size` bytes.
pub unsafe fn read_u32(data: *const c_void, size: usize, offset: usize) -> u32 {
    if offset + 4 > size {
        return 0;
    }
    ptr::read_unaligned((data as *const u8).add(offset) as *const u32)
}

/// # Safety
/// `p` is NULL or points to a NUL-terminated string.
pub unsafe fn extra_cstr(p: *const c_void) -> Extra {
    if p.is_null() {
        Extra::Str(None)
    } else {
        Extra::Str(Some(
            CStr::from_ptr(p as *const c_char)
                .to_string_lossy()
                .into_owned(),
        ))
    }
}

pub(crate) fn unavailable(method: &str, reason: &str) -> Error {
    Error::from_reason(format!(
        "{method} is not available from JavaScript: {reason}"
    ))
}
