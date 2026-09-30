//! SSE client registry — port of `surface/sse-hub.mjs`.
//!
//! Transport only: handshake / broadcast / heartbeat / eviction.
//! Event names and payloads are the callers' contract.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::task::AbortHandle;

/// Outbound message to one SSE client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HubEvent {
    /// SSE comment (`:\n\n`) — handshake ping / heartbeat.
    Comment,
    /// Named event with data payload.
    Named { event: String, data: String },
}

struct Client {
    tx: mpsc::UnboundedSender<HubEvent>,
    hb_abort: Option<AbortHandle>,
}

struct HubInner {
    clients: Mutex<HashMap<u64, Client>>,
    next_id: AtomicU64,
    heartbeat: Option<Duration>,
}

/// Shared SSE hub (cloneable).
#[derive(Clone)]
pub struct SseHub {
    inner: Arc<HubInner>,
}

/// RAII subscription: dropping removes the client (JS `req.on('close')`).
pub struct Subscription {
    id: u64,
    hub: SseHub,
    rx: mpsc::UnboundedReceiver<HubEvent>,
}

impl Subscription {
    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn receiver(&mut self) -> &mut mpsc::UnboundedReceiver<HubEvent> {
        &mut self.rx
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.hub.remove(self.id);
    }
}

impl SseHub {
    /// Create a hub. `heartbeat` mirrors JS `heartbeatMs` (None disables).
    pub fn new(heartbeat: Option<Duration>) -> Self {
        Self {
            inner: Arc::new(HubInner {
                clients: Mutex::new(HashMap::new()),
                next_id: AtomicU64::new(1),
                heartbeat,
            }),
        }
    }

    pub fn with_defaults() -> Self {
        Self::new(Some(Duration::from_millis(25_000)))
    }

    /// Number of connected clients.
    pub fn size(&self) -> usize {
        self.inner.clients.lock().expect("hub lock").len()
    }

    /// Subscribe a client. Stream handshake separately; then forward events.
    pub fn subscribe(&self) -> Subscription {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::unbounded_channel();
        let hb_abort = self.spawn_heartbeat(id, tx.clone());
        self.inner
            .clients
            .lock()
            .expect("hub lock")
            .insert(id, Client { tx, hb_abort });

        Subscription {
            id,
            hub: self.clone(),
            rx,
        }
    }

    fn spawn_heartbeat(
        &self,
        id: u64,
        tx_hb: mpsc::UnboundedSender<HubEvent>,
    ) -> Option<AbortHandle> {
        self.inner.heartbeat.map(|period| {
            let hub = self.clone();
            let handle = tokio::spawn(async move {
                let mut interval = tokio::time::interval(period);
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                interval.tick().await; // skip immediate first tick
                loop {
                    interval.tick().await;
                    if tx_hb.send(HubEvent::Comment).is_err() {
                        hub.remove(id);
                        break;
                    }
                }
            });
            handle.abort_handle()
        })
    }

    fn remove(&self, id: u64) {
        if let Some(client) = self.inner.clients.lock().expect("hub lock").remove(&id) {
            if let Some(abort) = client.hb_abort {
                abort.abort();
            }
        }
    }

    /// Broadcast `event` / `data` to all clients; evict dead senders.
    pub fn notify(&self, event: &str, data: &str) {
        let msg = HubEvent::Named {
            event: event.to_string(),
            data: data.to_string(),
        };
        let mut dead = Vec::new();
        {
            let clients = self.inner.clients.lock().expect("hub lock");
            for (id, client) in clients.iter() {
                if client.tx.send(msg.clone()).is_err() {
                    dead.push(*id);
                }
            }
        }
        for id in dead {
            self.remove(id);
        }
    }

    /// Test seam: insert a client whose receiver is already closed (JS `res.dead`).
    #[cfg(test)]
    pub fn inject_dead_client(&self) {
        let (tx, rx) = mpsc::unbounded_channel();
        drop(rx);
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let hb_abort = self.spawn_heartbeat(id, tx.clone());
        self.inner
            .clients
            .lock()
            .expect("hub lock")
            .insert(id, Client { tx, hb_abort });
    }
}

impl Default for SseHub {
    fn default() -> Self {
        Self::with_defaults()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn subscribe_size_and_drop_on_disconnect() {
        let hub = SseHub::new(None);
        assert_eq!(hub.size(), 0);
        let sub = hub.subscribe();
        assert_eq!(hub.size(), 1);
        drop(sub);
        assert_eq!(hub.size(), 0);
    }

    #[tokio::test]
    async fn notify_broadcasts_to_all_clients() {
        let hub = SseHub::new(None);
        let mut a = hub.subscribe();
        let mut b = hub.subscribe();
        hub.notify("updated", "2026-06-12T00:00:00Z");
        let expected = HubEvent::Named {
            event: "updated".into(),
            data: "2026-06-12T00:00:00Z".into(),
        };
        assert_eq!(a.receiver().recv().await.unwrap(), expected);
        assert_eq!(b.receiver().recv().await.unwrap(), expected);
    }

    #[tokio::test]
    async fn notify_evicts_dead_clients() {
        let hub = SseHub::new(None);
        let mut live = hub.subscribe();
        hub.inject_dead_client();
        assert_eq!(hub.size(), 2);
        hub.notify("status", "rebuilding");
        assert_eq!(hub.size(), 1);
        assert_eq!(
            live.receiver().recv().await.unwrap(),
            HubEvent::Named {
                event: "status".into(),
                data: "rebuilding".into(),
            }
        );
    }

    #[tokio::test]
    async fn heartbeat_evicts_dead_client_on_ping_failure() {
        let hub = SseHub::new(Some(Duration::from_millis(5)));
        hub.inject_dead_client();
        assert_eq!(hub.size(), 1);
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert_eq!(hub.size(), 0);
    }
}
