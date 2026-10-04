//! Seat idle observation through `ext_idle_notifier_v1`.
//!
//! This is the one signal the capability probe could not answer before: the
//! protocol is visible only to a Wayland client, and the collector had none. The
//! connection below watches the *seat* - "no input for at least the timeout" - and
//! never names a window, an application or a document.
//!
//! The client is pure Rust and resolves libwayland at runtime, so the binary gains
//! no runtime dependency of its own; on a host with no Wayland display every entry
//! point here fails with a reason, which the probe reports as unavailable rather
//! than as calm.

use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::Duration;

use wayland_client::globals::{registry_queue_init, GlobalListContents};
use wayland_client::protocol::wl_registry::{Event as RegistryEvent, WlRegistry};
use wayland_client::protocol::wl_seat::WlSeat;
use wayland_client::{delegate_noop, Connection, Dispatch, EventQueue, QueueHandle};
use wayland_protocols::ext::idle_notify::v1::client::ext_idle_notification_v1::{
    Event as IdleNotificationEvent, ExtIdleNotificationV1,
};
use wayland_protocols::ext::idle_notify::v1::client::ext_idle_notifier_v1::ExtIdleNotifierV1;

/// The default quiet window. A minute at the desk is a pause; five is a review item,
/// and the person is the only one who decides which it was.
pub const DEFAULT_TIMEOUT_MS: u32 = 300_000;

/// A seat transition, as the compositor reported it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdleSignal {
    Idle,
    Resumed,
}

/// What the seat reported within a wait.
pub enum Next {
    /// A transition arrived.
    Transition(IdleSignal),
    /// Nothing happened inside the wait: the sampling loop carries on.
    Quiet,
    /// The observation thread ended; idle can no longer be observed this run.
    Ended,
}

struct State {
    signals: Sender<IdleSignal>,
    _seat: WlSeat,
    _notifier: ExtIdleNotifierV1,
    _notification: ExtIdleNotificationV1,
}

impl Dispatch<WlRegistry, GlobalListContents> for State {
    fn event(
        _state: &mut Self,
        _proxy: &WlRegistry,
        _event: RegistryEvent,
        _data: &GlobalListContents,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
    ) {
        // `registry_queue_init` already collected the globals; individual
        // announcements need no handling of their own.
    }
}

impl Dispatch<ExtIdleNotificationV1, ()> for State {
    fn event(
        state: &mut Self,
        _proxy: &ExtIdleNotificationV1,
        event: IdleNotificationEvent,
        _data: &(),
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
    ) {
        let signal = match event {
            IdleNotificationEvent::Idled => IdleSignal::Idle,
            IdleNotificationEvent::Resumed => IdleSignal::Resumed,
            // Non-exhaustive: an event this build does not know is not one to guess at.
            _ => return,
        };
        // The receiver may be gone; the observation itself is still valid, so a
        // failed send is not worth ending the thread for.
        let _ = state.signals.send(signal);
    }
}

delegate_noop!(State: ignore WlSeat);
delegate_noop!(State: ignore ExtIdleNotifierV1);

/// A bound subscription. The connection stays open for as long as this is held:
/// dropping it disarms the notification.
struct Watch {
    _connection: Connection,
    queue: EventQueue<State>,
    state: State,
}

/// Bind the seat's idle notifier, or say why this display cannot offer it.
fn bind(timeout_ms: u32, signals: Sender<IdleSignal>) -> Result<Watch, String> {
    let connection = Connection::connect_to_env()
        .map_err(|error| format!("no Wayland connection for this session ({error})"))?;
    let (globals, queue) = registry_queue_init::<State>(&connection)
        .map_err(|error| format!("the Wayland registry could not be read ({error})"))?;
    let qh = queue.handle();
    let seat: WlSeat = globals
        .bind(&qh, 1..=9, ())
        .map_err(|_| "the compositor advertises no seat to watch".to_string())?;
    let notifier: ExtIdleNotifierV1 = globals
        .bind(&qh, 1..=2, ())
        .map_err(|_| "the compositor does not offer ext_idle_notifier_v1".to_string())?;
    let notification = notifier.get_idle_notification(timeout_ms, &seat, &qh, ());
    Ok(Watch {
        _connection: connection,
        queue,
        state: State {
            signals,
            _seat: seat,
            _notifier: notifier,
            _notification: notification,
        },
    })
}

/// What this display offers, in one line that names the reason either way.
pub fn probe() -> (bool, String) {
    let (signals, _receiver) = channel();
    match bind(DEFAULT_TIMEOUT_MS, signals) {
        Ok(_) => (
            true,
            format!("ext_idle_notifier_v1 bound on this seat; idle is observed after {DEFAULT_TIMEOUT_MS} ms without input"),
        ),
        Err(reason) => (false, reason),
    }
}

/// A running subscription: the observation thread owns the connection, the caller
/// owns the receiving end.
pub struct Observer {
    signals: Receiver<IdleSignal>,
}

impl Observer {
    /// Transitions as they arrive. `Ended` from [`next`] means the observation
    /// thread stopped, which the caller has to report rather than ignore.
    pub fn signals(&self) -> &Receiver<IdleSignal> {
        &self.signals
    }
}

/// Observe the seat on its own connection and thread: the sampling loop must never
/// wait on the compositor, and the compositor must never wait on `hyprctl`.
pub fn observe(timeout_ms: u32) -> Result<Observer, String> {
    let (signals, receiver) = channel();
    let (ready, readiness) = channel::<Result<(), String>>();
    // The thread is deliberately detached: it ends with the process, and the
    // connection has to stay owned by the thread that dispatches it.
    thread::spawn(move || match bind(timeout_ms, signals) {
        Ok(mut watch) => {
            let _ = ready.send(Ok(()));
            loop {
                // This blocks - that is the point - and it flushes the request that
                // armed the notification before it waits.
                if watch.queue.blocking_dispatch(&mut watch.state).is_err() {
                    return;
                }
            }
        }
        Err(reason) => {
            let _ = ready.send(Err(reason));
        }
    });
    // Availability means "bound in the thread that will use it", not "bound once".
    match readiness.recv() {
        Ok(Ok(())) => Ok(Observer { signals: receiver }),
        Ok(Err(reason)) => Err(reason),
        Err(_) => Err("the idle observation thread ended before it reported".to_string()),
    }
}

/// The seat's next transition, or `Quiet` when `wait` elapses first.
pub fn next(signals: &Receiver<IdleSignal>, wait: Duration) -> Next {
    match signals.recv_timeout(wait) {
        Ok(signal) => Next::Transition(signal),
        Err(RecvTimeoutError::Timeout) => Next::Quiet,
        Err(RecvTimeoutError::Disconnected) => Next::Ended,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_display_that_cannot_be_reached_is_unavailable_with_a_reason() {
        // The probe answers "unavailable, because ..." when there is no display. It
        // must never answer "available" on a guess, and the failure must never be
        // silent: an absence of idle events has to be explainable.
        let previous = std::env::var("WAYLAND_DISPLAY").ok();
        std::env::set_var("WAYLAND_DISPLAY", "/nonexistent-workspan-probe");
        let (available, detail) = probe();
        match previous {
            Some(value) => std::env::set_var("WAYLAND_DISPLAY", value),
            None => std::env::remove_var("WAYLAND_DISPLAY"),
        }
        assert!(!available, "a bogus display must not report availability");
        assert!(!detail.is_empty(), "unavailable always names a reason");
    }
}
