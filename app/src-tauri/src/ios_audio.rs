//! iOS audio session + screen-idle management.
//!
//! cpal opens CoreAudio streams but never touches `AVAudioSession`, so a stock
//! iOS build would record nothing (the default `soloAmbient` category has no
//! input route) and would send backing playback to the earpiece instead of the
//! speaker. Both the capture side (`audio.rs`) and the playback side
//! (`backing.rs`) call `configure_session()` before building their stream:
//! it sets the `playAndRecord` category with speaker/bluetooth routing and
//! activates the session.
//!
//! `install_observers()` (called once from `lib.rs` setup) watches for the two
//! events that otherwise leave the app silently dead: an *interruption* (phone
//! call, Siri, another app taking the session) and a *route change* (headphones
//! unplugged, bluetooth disconnected). iOS deactivates our session on
//! interruption and does not restore it, so without this the user has to
//! manually restart listening/playback. The observers re-activate the session
//! and emit `audio_interruption` / `audio_route_change` events; the frontend
//! owns the decision to resume, since only it knows whether the user was
//! listening, playing, or both.
//!
//! `set_idle_timer_disabled()` keeps the screen awake while the transport runs.
//! A play-along app is by definition untouched while you play, so the default
//! ~30 s auto-lock would black the screen out mid-song.
//!
//! Implemented with raw `objc2` message sends (rather than the AVFAudio
//! binding crates) to keep the iOS-only dependency surface minimal. Category
//! and notification names are passed by their string values — Apple defines the
//! exported `AVAudioSession*` constants as strings equal to their own names.

/// Emitted to the frontend when the audio session is interrupted or restored.
/// Only ever constructed on iOS; kept unconditional so the payload shape stays
/// visible alongside the frontend listener that consumes it.
#[derive(serde::Serialize, Clone)]
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub struct InterruptionEvent {
    /// True when the interruption began (audio is dead), false when it ended
    /// (the session has been re-activated and it is safe to resume).
    pub began: bool,
}

/// Emitted to the frontend when the audio route changes (headphones etc.).
#[derive(serde::Serialize, Clone)]
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub struct RouteChangeEvent {
    /// Raw `AVAudioSessionRouteChangeReason`. 2 = old device unavailable, i.e.
    /// headphones were unplugged — the case that warrants pausing.
    pub reason: i64,
}

#[cfg(target_os = "ios")]
pub fn configure_session() -> Result<(), String> {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use std::ffi::c_char;

    // AVAudioSessionCategoryOptions bits.
    const ALLOW_BLUETOOTH: usize = 0x4;
    const DEFAULT_TO_SPEAKER: usize = 0x8;
    const ALLOW_BLUETOOTH_A2DP: usize = 0x20;

    unsafe {
        let session: *mut AnyObject = msg_send![class!(AVAudioSession), sharedInstance];
        if session.is_null() {
            return Err("AVAudioSession unavailable".into());
        }

        let name = b"AVAudioSessionCategoryPlayAndRecord\0";
        let category: *mut AnyObject = msg_send![
            class!(NSString),
            stringWithUTF8String: name.as_ptr() as *const c_char
        ];

        let options: usize = ALLOW_BLUETOOTH | DEFAULT_TO_SPEAKER | ALLOW_BLUETOOTH_A2DP;
        let mut err: *mut AnyObject = std::ptr::null_mut();
        let ok: bool = msg_send![
            session,
            setCategory: category,
            withOptions: options,
            error: &mut err
        ];
        if !ok {
            return Err("audio session: setCategory(playAndRecord) failed".into());
        }

        let mut err: *mut AnyObject = std::ptr::null_mut();
        let ok: bool = msg_send![session, setActive: true, error: &mut err];
        if !ok {
            return Err("audio session: activation failed (another app may hold it)".into());
        }
    }
    Ok(())
}

/// Build an autoreleased `NSString` from a NUL-terminated byte literal.
#[cfg(target_os = "ios")]
unsafe fn nsstring(bytes: &'static [u8]) -> *mut objc2::runtime::AnyObject {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use std::ffi::c_char;
    debug_assert_eq!(bytes.last(), Some(&0), "notification name must be NUL-terminated");
    let s: *mut AnyObject = msg_send![
        class!(NSString),
        stringWithUTF8String: bytes.as_ptr() as *const c_char
    ];
    s
}

/// Read an integer out of a notification's `userInfo` dictionary.
#[cfg(target_os = "ios")]
unsafe fn user_info_int(note: *mut objc2::runtime::AnyObject, key: &'static [u8]) -> Option<i64> {
    use objc2::runtime::AnyObject;
    use objc2::msg_send;

    let info: *mut AnyObject = msg_send![note, userInfo];
    if info.is_null() {
        return None;
    }
    let value: *mut AnyObject = msg_send![info, objectForKey: nsstring(key)];
    if value.is_null() {
        return None;
    }
    let n: i64 = msg_send![value, longLongValue];
    Some(n)
}

/// Register the interruption + route-change observers. Call once, from setup.
#[cfg(target_os = "ios")]
pub fn install_observers(app: tauri::AppHandle) {
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use tauri::Emitter;

    // AVAudioSessionInterruptionType
    const INTERRUPTION_BEGAN: i64 = 1;
    // AVAudioSessionRouteChangeReason: the route we were using went away.
    const REASON_OLD_DEVICE_UNAVAILABLE: i64 = 2;

    unsafe {
        let session: *mut AnyObject = msg_send![class!(AVAudioSession), sharedInstance];
        if session.is_null() {
            return;
        }
        let center: *mut AnyObject = msg_send![class!(NSNotificationCenter), defaultCenter];
        let queue: *mut AnyObject = msg_send![class!(NSOperationQueue), mainQueue];

        // --- interruptions (phone call, Siri, another app grabbing audio) ---
        let interruption_app = app.clone();
        let on_interruption = RcBlock::new(move |note: *mut AnyObject| {
            let began = user_info_int(note, b"AVAudioSessionInterruptionType\0")
                .map(|t| t == INTERRUPTION_BEGAN)
                .unwrap_or(false);
            // iOS tears our session down on `began` and leaves it down; bring
            // it back before telling the frontend it may resume.
            if !began {
                let _ = configure_session();
            }
            let _ = interruption_app.emit("audio_interruption", InterruptionEvent { began });
        });
        let _: *mut AnyObject = msg_send![
            center,
            addObserverForName: nsstring(b"AVAudioSessionInterruptionNotification\0"),
            object: session,
            queue: queue,
            usingBlock: &*on_interruption
        ];
        // The notification center holds its own copy, but the block must
        // outlive this function either way — it is never unregistered.
        std::mem::forget(on_interruption);

        // --- route changes (headphones unplugged, bluetooth dropped) ---
        let route_app = app.clone();
        let on_route = RcBlock::new(move |note: *mut AnyObject| {
            let reason =
                user_info_int(note, b"AVAudioSessionRouteChangeReasonKey\0").unwrap_or(0);
            // Losing the active output also drops the input in playAndRecord;
            // re-activating restores routing to the built-in speaker/mic.
            if reason == REASON_OLD_DEVICE_UNAVAILABLE {
                let _ = configure_session();
            }
            let _ = route_app.emit("audio_route_change", RouteChangeEvent { reason });
        });
        let _: *mut AnyObject = msg_send![
            center,
            addObserverForName: nsstring(b"AVAudioSessionRouteChangeNotification\0"),
            object: session,
            queue: queue,
            usingBlock: &*on_route
        ];
        std::mem::forget(on_route);
    }
}

/// Keep the screen awake (`true`) or let it auto-lock again (`false`).
///
/// `UIApplication` is main-thread-only, hence the hop.
#[cfg(target_os = "ios")]
pub fn set_idle_timer_disabled(app: &tauri::AppHandle, disabled: bool) {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};

    let _ = app.run_on_main_thread(move || unsafe {
        let ui: *mut AnyObject = msg_send![class!(UIApplication), sharedApplication];
        if !ui.is_null() {
            let _: () = msg_send![ui, setIdleTimerDisabled: disabled];
        }
    });
}

/// No-op everywhere else: desktop cpal streams need no session management.
#[cfg(not(target_os = "ios"))]
pub fn configure_session() -> Result<(), String> {
    Ok(())
}

/// No-op everywhere else: only iOS interrupts audio out from under us.
#[cfg(not(target_os = "ios"))]
pub fn install_observers(_app: tauri::AppHandle) {}

/// No-op everywhere else: desktop screensavers don't interrupt a play-along.
#[cfg(not(target_os = "ios"))]
pub fn set_idle_timer_disabled(_app: &tauri::AppHandle, _disabled: bool) {}
