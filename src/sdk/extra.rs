//! Types that steamworks-sys only forward-declares.
//!
//! steamworks-sys generates its bindings from `steam_api_flat.h`, which only
//! forward-declares these structs, so bindgen emits zero-sized placeholders.
//! The definitions below are transcribed from the SDK headers named on each
//! type. The generator (`scripts/sdk/generate.mjs`) parses this file with the
//! same parser it uses for the bindgen output, so keep the bindgen style:
//! one `pub field: Type,` per line.
#![allow(non_camel_case_types, non_snake_case, dead_code)]

use steamworks::sys;

// isteamdualsense.h (no #pragma pack: natural alignment)

#[repr(C)]
#[derive(Copy, Clone)]
pub struct ScePadTriggerEffectOffParam {
    pub padding: [u8; 48usize],
}

#[repr(C)]
#[derive(Copy, Clone)]
pub struct ScePadTriggerEffectFeedbackParam {
    pub position: u8,
    pub strength: u8,
    pub padding: [u8; 46usize],
}

#[repr(C)]
#[derive(Copy, Clone)]
pub struct ScePadTriggerEffectWeaponParam {
    pub startPosition: u8,
    pub endPosition: u8,
    pub strength: u8,
    pub padding: [u8; 45usize],
}

#[repr(C)]
#[derive(Copy, Clone)]
pub struct ScePadTriggerEffectVibrationParam {
    pub position: u8,
    pub amplitude: u8,
    pub frequency: u8,
    pub padding: [u8; 45usize],
}

#[repr(C)]
#[derive(Copy, Clone)]
pub struct ScePadTriggerEffectMultiplePositionFeedbackParam {
    pub strength: [u8; 10usize],
    pub padding: [u8; 38usize],
}

#[repr(C)]
#[derive(Copy, Clone)]
pub struct ScePadTriggerEffectSlopeFeedbackParam {
    pub startPosition: u8,
    pub endPosition: u8,
    pub startStrength: u8,
    pub endStrength: u8,
    pub padding: [u8; 44usize],
}

#[repr(C)]
#[derive(Copy, Clone)]
pub struct ScePadTriggerEffectMultiplePositionVibrationParam {
    pub frequency: u8,
    pub amplitude: [u8; 10usize],
    pub padding: [u8; 37usize],
}

#[repr(C)]
#[derive(Copy, Clone)]
pub union ScePadTriggerEffectCommandData {
    pub offParam: ScePadTriggerEffectOffParam,
    pub feedbackParam: ScePadTriggerEffectFeedbackParam,
    pub weaponParam: ScePadTriggerEffectWeaponParam,
    pub vibrationParam: ScePadTriggerEffectVibrationParam,
    pub multiplePositionFeedbackParam: ScePadTriggerEffectMultiplePositionFeedbackParam,
    pub slopeFeedbackParam: ScePadTriggerEffectSlopeFeedbackParam,
    pub multiplePositionVibrationParam: ScePadTriggerEffectMultiplePositionVibrationParam,
}

#[repr(C)]
#[derive(Copy, Clone)]
pub struct ScePadTriggerEffectCommand {
    pub mode: ScePadTriggerEffectMode,
    pub padding: [u8; 4usize],
    pub commandData: ScePadTriggerEffectCommandData,
}

#[repr(C)]
#[derive(Copy, Clone)]
pub struct ScePadTriggerEffectParam {
    pub triggerMask: u8,
    pub padding: [u8; 7usize],
    pub command: [ScePadTriggerEffectCommand; 2usize],
}

pub type ScePadTriggerEffectMode = u32;

// steamnetworkingfakeip.h: #pragma pack(4) with VALVE_CALLBACK_PACK_SMALL
// (Linux, macOS) and pack(8) with VALVE_CALLBACK_PACK_LARGE (Windows).

#[cfg_attr(windows, repr(C, packed(8)))]
#[cfg_attr(not(windows), repr(C, packed(4)))]
#[derive(Copy, Clone)]
pub struct SteamNetworkingFakeIPResult_t {
    pub m_eResult: sys::EResult,
    pub m_identity: sys::SteamNetworkingIdentity,
    pub m_unIP: sys::uint32,
    pub m_unPorts: [sys::uint16; 8usize],
}

const _: () = assert!(std::mem::size_of::<ScePadTriggerEffectCommandData>() == 48);
const _: () = assert!(std::mem::size_of::<ScePadTriggerEffectCommand>() == 56);
const _: () = assert!(std::mem::size_of::<ScePadTriggerEffectParam>() == 120);
const _: () = assert!(
    std::mem::size_of::<SteamNetworkingFakeIPResult_t>()
        == 4 + std::mem::size_of::<sys::SteamNetworkingIdentity>() + 4 + 16
);
