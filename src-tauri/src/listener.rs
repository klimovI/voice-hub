use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rdev::{Button, Event, EventType, Key};
use tauri::{AppHandle, Emitter};

use crate::shortcut::{self, InputBinding};

const COOLDOWN: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Normal,
    Capturing,
}

pub struct ListenerState {
    pub current: Option<InputBinding>,
    pub mode: Mode,
    pub pressed: HashSet<Key>,
    pub last_fire: Option<Instant>,
}

impl ListenerState {
    pub fn new(current: Option<InputBinding>) -> Self {
        Self {
            current,
            mode: Mode::Normal,
            pressed: HashSet::new(),
            last_fire: None,
        }
    }
}

pub type SharedState = Arc<Mutex<ListenerState>>;

pub fn start(app: AppHandle, state: SharedState) {
    std::thread::spawn(move || {
        let cb_state = state.clone();
        let cb_app = app.clone();
        let result = rdev::listen(move |event: Event| {
            let mut s = match cb_state.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            handle_event(&mut s, &cb_app, &event);
        });
        if let Err(err) = result {
            eprintln!("rdev listen failed: {err:?}");
        }
    });
}

fn handle_event(state: &mut ListenerState, app: &AppHandle, event: &Event) {
    match &event.event_type {
        EventType::KeyPress(k) => {
            let was_modifier = is_modifier(k);
            state.pressed.insert(*k);
            match state.mode {
                // Edge-trigger: fire only on press of the non-modifier key.
                // Pressing a modifier while a non-modifier is already held must
                // not retro-fire the binding.
                Mode::Normal if !was_modifier => try_fire_keyboard(state, app),
                Mode::Normal => {}
                Mode::Capturing => try_capture_keyboard(state, app, *k),
            }
        }
        EventType::KeyRelease(k) => {
            state.pressed.remove(k);
        }
        EventType::ButtonPress(b) => match state.mode {
            Mode::Normal => {
                if matches_mouse(state.current.as_ref(), b) {
                    fire_toggle(state, app);
                }
            }
            Mode::Capturing => try_capture_mouse(state, app, b),
        },
        _ => {}
    }
}

// ---- Normal mode ----

fn try_fire_keyboard(state: &mut ListenerState, app: &AppHandle) {
    let Some(binding) = state.current.clone() else {
        return;
    };
    if !matches_keyboard(&binding, &state.pressed) {
        return;
    }
    fire_toggle(state, app);
}

fn fire_toggle(state: &mut ListenerState, app: &AppHandle) {
    let now = Instant::now();
    if let Some(prev) = state.last_fire {
        if now.duration_since(prev) < COOLDOWN {
            return;
        }
    }
    state.last_fire = Some(now);
    let _ = app.emit("toggle-mute", ());
}

fn matches_keyboard(binding: &InputBinding, pressed: &HashSet<Key>) -> bool {
    let keys = match binding {
        InputBinding::Keyboard { keys } => keys,
        _ => return false,
    };

    let want_ctrl = keys.iter().any(|k| k == "Ctrl");
    let want_shift = keys.iter().any(|k| k == "Shift");
    let want_alt = keys.iter().any(|k| k == "Alt");
    let want_meta = keys.iter().any(|k| k == "Meta");

    if want_ctrl != has_ctrl(pressed) {
        return false;
    }
    if want_shift != has_shift(pressed) {
        return false;
    }
    if want_alt != has_alt(pressed) {
        return false;
    }
    if want_meta != has_meta(pressed) {
        return false;
    }

    for label in keys {
        if matches!(label.as_str(), "Ctrl" | "Shift" | "Alt" | "Meta") {
            continue;
        }
        let Some(target) = label_to_key(label) else {
            return false;
        };
        if !pressed.contains(&target) {
            return false;
        }
    }
    true
}

fn matches_mouse(current: Option<&InputBinding>, btn: &Button) -> bool {
    let Some(InputBinding::Mouse { button }) = current else {
        return false;
    };
    button_label(btn).as_deref() == Some(button.as_str())
}

// ---- Capturing mode ----

fn try_capture_keyboard(state: &mut ListenerState, app: &AppHandle, k: Key) {
    if is_modifier(&k) {
        return;
    }
    let Some(label) = key_label(&k) else {
        return;
    };

    let mut keys: Vec<String> = Vec::new();
    if has_ctrl(&state.pressed) {
        keys.push("Ctrl".into());
    }
    if has_shift(&state.pressed) {
        keys.push("Shift".into());
    }
    if has_alt(&state.pressed) {
        keys.push("Alt".into());
    }
    if has_meta(&state.pressed) {
        keys.push("Meta".into());
    }

    let has_modifier = !keys.is_empty();
    if !has_modifier && !is_solo_allowed(&label) {
        // Disallow solo letters/digits/space — too easy to mis-trigger while typing.
        return;
    }
    keys.push(label);

    let binding = InputBinding::Keyboard { keys };
    finalize_capture(state, app, binding);
}

fn try_capture_mouse(state: &mut ListenerState, app: &AppHandle, btn: &Button) {
    let Some(label) = button_label(btn) else {
        return;
    };
    let binding = InputBinding::Mouse { button: label };
    finalize_capture(state, app, binding);
}

fn finalize_capture(state: &mut ListenerState, app: &AppHandle, binding: InputBinding) {
    if let Err(err) = shortcut::save(app, &binding) {
        eprintln!("save shortcut: {err}");
    }
    state.current = Some(binding.clone());
    state.mode = Mode::Normal;
    state.last_fire = Some(Instant::now()); // suppress retrigger from same press
    let _ = app.emit("input-captured", binding);
}

// ---- Allowlist for solo (no-modifier) keys ----

fn is_solo_allowed(label: &str) -> bool {
    matches!(
        label,
        "Pause"
            | "Insert"
            | "Home"
            | "End"
            | "PageUp"
            | "PageDown"
            | "ScrollLock"
            | "NumLock"
            | "PrintScreen"
            | "F1"
            | "F2"
            | "F3"
            | "F4"
            | "F5"
            | "F6"
            | "F7"
            | "F8"
            | "F9"
            | "F10"
            | "F11"
            | "F12"
    )
}

// ---- Modifier helpers ----

fn is_modifier(k: &Key) -> bool {
    matches!(
        k,
        Key::ControlLeft
            | Key::ControlRight
            | Key::ShiftLeft
            | Key::ShiftRight
            | Key::Alt
            | Key::AltGr
            | Key::MetaLeft
            | Key::MetaRight
    )
}

fn has_ctrl(p: &HashSet<Key>) -> bool {
    p.contains(&Key::ControlLeft) || p.contains(&Key::ControlRight)
}
fn has_shift(p: &HashSet<Key>) -> bool {
    p.contains(&Key::ShiftLeft) || p.contains(&Key::ShiftRight)
}
fn has_alt(p: &HashSet<Key>) -> bool {
    p.contains(&Key::Alt) || p.contains(&Key::AltGr)
}
fn has_meta(p: &HashSet<Key>) -> bool {
    p.contains(&Key::MetaLeft) || p.contains(&Key::MetaRight)
}

// ---- Mouse button mapping ----

fn button_label(b: &Button) -> Option<String> {
    match b {
        Button::Right => Some("Right".to_string()),
        Button::Middle => Some("Middle".to_string()),
        Button::Unknown(n) => Some(format!("Side{n}")),
        _ => None, // Left intentionally excluded
    }
}

// ---- Key label mapping (round-trip) ----

fn key_label(k: &Key) -> Option<String> {
    Some(
        match k {
            Key::KeyA => "A",
            Key::KeyB => "B",
            Key::KeyC => "C",
            Key::KeyD => "D",
            Key::KeyE => "E",
            Key::KeyF => "F",
            Key::KeyG => "G",
            Key::KeyH => "H",
            Key::KeyI => "I",
            Key::KeyJ => "J",
            Key::KeyK => "K",
            Key::KeyL => "L",
            Key::KeyM => "M",
            Key::KeyN => "N",
            Key::KeyO => "O",
            Key::KeyP => "P",
            Key::KeyQ => "Q",
            Key::KeyR => "R",
            Key::KeyS => "S",
            Key::KeyT => "T",
            Key::KeyU => "U",
            Key::KeyV => "V",
            Key::KeyW => "W",
            Key::KeyX => "X",
            Key::KeyY => "Y",
            Key::KeyZ => "Z",
            Key::Num0 => "0",
            Key::Num1 => "1",
            Key::Num2 => "2",
            Key::Num3 => "3",
            Key::Num4 => "4",
            Key::Num5 => "5",
            Key::Num6 => "6",
            Key::Num7 => "7",
            Key::Num8 => "8",
            Key::Num9 => "9",
            Key::F1 => "F1",
            Key::F2 => "F2",
            Key::F3 => "F3",
            Key::F4 => "F4",
            Key::F5 => "F5",
            Key::F6 => "F6",
            Key::F7 => "F7",
            Key::F8 => "F8",
            Key::F9 => "F9",
            Key::F10 => "F10",
            Key::F11 => "F11",
            Key::F12 => "F12",
            Key::Space => "Space",
            Key::Tab => "Tab",
            Key::CapsLock => "CapsLock",
            Key::Insert => "Insert",
            Key::Home => "Home",
            Key::End => "End",
            Key::PageUp => "PageUp",
            Key::PageDown => "PageDown",
            Key::Pause => "Pause",
            Key::ScrollLock => "ScrollLock",
            Key::NumLock => "NumLock",
            Key::PrintScreen => "PrintScreen",
            _ => return None,
        }
        .to_string(),
    )
}

fn label_to_key(label: &str) -> Option<Key> {
    Some(match label {
        "A" => Key::KeyA,
        "B" => Key::KeyB,
        "C" => Key::KeyC,
        "D" => Key::KeyD,
        "E" => Key::KeyE,
        "F" => Key::KeyF,
        "G" => Key::KeyG,
        "H" => Key::KeyH,
        "I" => Key::KeyI,
        "J" => Key::KeyJ,
        "K" => Key::KeyK,
        "L" => Key::KeyL,
        "M" => Key::KeyM,
        "N" => Key::KeyN,
        "O" => Key::KeyO,
        "P" => Key::KeyP,
        "Q" => Key::KeyQ,
        "R" => Key::KeyR,
        "S" => Key::KeyS,
        "T" => Key::KeyT,
        "U" => Key::KeyU,
        "V" => Key::KeyV,
        "W" => Key::KeyW,
        "X" => Key::KeyX,
        "Y" => Key::KeyY,
        "Z" => Key::KeyZ,
        "0" => Key::Num0,
        "1" => Key::Num1,
        "2" => Key::Num2,
        "3" => Key::Num3,
        "4" => Key::Num4,
        "5" => Key::Num5,
        "6" => Key::Num6,
        "7" => Key::Num7,
        "8" => Key::Num8,
        "9" => Key::Num9,
        "F1" => Key::F1,
        "F2" => Key::F2,
        "F3" => Key::F3,
        "F4" => Key::F4,
        "F5" => Key::F5,
        "F6" => Key::F6,
        "F7" => Key::F7,
        "F8" => Key::F8,
        "F9" => Key::F9,
        "F10" => Key::F10,
        "F11" => Key::F11,
        "F12" => Key::F12,
        "Space" => Key::Space,
        "Tab" => Key::Tab,
        "CapsLock" => Key::CapsLock,
        "Insert" => Key::Insert,
        "Home" => Key::Home,
        "End" => Key::End,
        "PageUp" => Key::PageUp,
        "PageDown" => Key::PageDown,
        "Pause" => Key::Pause,
        "ScrollLock" => Key::ScrollLock,
        "NumLock" => Key::NumLock,
        "PrintScreen" => Key::PrintScreen,
        _ => return None,
    })
}
