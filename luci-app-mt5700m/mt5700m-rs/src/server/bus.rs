// Broadcast registry for WebSocket notifications.
//
// Every connected WebSocket client registers a `mpsc::Sender<String>` here.
// When a message handler (SMS / call / signal / PDCP / raw URC) produces an
// outbound event it calls `broadcast`, which fans the JSON string out to all
// live clients and prunes any connections that have gone away.

use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

pub type Bus = Arc<Mutex<Vec<Sender<String>>>>;

/// Register a new client's outbound sender.
pub fn register(bus: &Bus, tx: Sender<String>) {
    bus.lock().unwrap().push(tx);
}

/// Send `msg` to every connected client.  Dead senders (client gone) are
/// removed lazily so the registry does not grow without bound.
pub fn broadcast(bus: &Bus, msg: &str) {
    let mut g = bus.lock().unwrap();
    if g.is_empty() {
        return;
    }
    let mut dead = Vec::new();
    for (i, tx) in g.iter().enumerate() {
        if tx.send(msg.to_string()).is_err() {
            dead.push(i);
        }
    }
    // Remove highest indices first to keep earlier offsets valid.
    for i in dead.into_iter().rev() {
        g.remove(i);
    }
}
