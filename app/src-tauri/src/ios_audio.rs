//! iOS audio session configuration.
//!
//! cpal opens CoreAudio streams but never touches `AVAudioSession`, so a stock
//! iOS build would record nothing (the default `soloAmbient` category has no
//! input route) and would send backing playback to the earpiece instead of the
//! speaker. Both the capture side (`audio.rs`) and the playback side
//! (`backing.rs`) call `configure_session()` before building their stream:
//! it sets the `playAndRecord` category with speaker/bluetooth routing and
//! activates the session. Re-activating on every stream start also recovers
//! the session after a phone call or Siri interruption once the user restarts
//! listening or playback.
//!
//! Implemented with raw `objc2` message sends (rather than the AVFAudio
//! binding crates) to keep the iOS-only dependency surface minimal. The
//! category is passed by its string value — Apple defines the exported
//! `AVAudioSessionCategory*` constants as strings equal to their own names.

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

/// No-op everywhere else: desktop cpal streams need no session management.
#[cfg(not(target_os = "ios"))]
pub fn configure_session() -> Result<(), String> {
    Ok(())
}
