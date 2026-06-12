//! Provider 级负载调度。
//!
//! 目标：
//! - 同一会话优先固定到同一 Provider，减少上游缓存 miss。
//! - 新会话分配时避开已满载 Provider；已绑定会话继续走原 Provider。
//! - 仅使用运行态计数，不写数据库。

use crate::provider::{Provider, ProviderLoadLimits};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::sync::{OwnedSemaphorePermit, RwLock, Semaphore};

const RPM_WINDOW: Duration = Duration::from_secs(60);
const SESSION_FAILURE_COOLDOWN: Duration = Duration::from_secs(10 * 60);
const LOAD_SCORE_SCALE: u64 = 1_000_000;

#[derive(Clone, Default)]
pub struct ProviderLoadBalancer {
    inner: Arc<RwLock<LoadState>>,
}

#[derive(Default)]
struct LoadState {
    semaphores: HashMap<String, Arc<Semaphore>>,
    rpm_windows: HashMap<String, VecDeque<Instant>>,
    sticky_sessions: HashMap<String, StickyProvider>,
    session_failures: HashMap<String, HashMap<String, Instant>>,
    active_requests: HashMap<(String, String), Arc<AtomicUsize>>,
    active_unbound_requests: HashMap<(String, String), Arc<AtomicUsize>>,
    round_robin_cursors: HashMap<String, usize>,
}

struct StickyProvider {
    app_type: String,
    session_id: String,
    provider_id: String,
    last_seen: Instant,
    session_slot: Option<OwnedSemaphorePermit>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ActiveSessionTarget {
    pub app_type: String,
    pub provider_id: String,
    pub active_connections: usize,
    pub session_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CapacityDecision {
    Available,
    RpmFull,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderLoadRejectReason {
    ConcurrencyFull,
    RpmFull,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProviderLoadRejected {
    pub reason: ProviderLoadRejectReason,
}

pub struct ProviderLoadPermit {
    provider_key: String,
    active_request_counter: Option<Arc<AtomicUsize>>,
    active_unbound_request_counter: Option<Arc<AtomicUsize>>,
    semaphore_permit: Option<OwnedSemaphorePermit>,
    balancer: ProviderLoadBalancer,
}

impl Drop for ProviderLoadPermit {
    fn drop(&mut self) {
        let _ = self.semaphore_permit.take();
        if let Some(counter) = self.active_unbound_request_counter.take() {
            decrement_active_request_counter(&counter);
        }
        if let Some(counter) = self.active_request_counter.take() {
            decrement_active_request_counter(&counter);
        }
        let balancer = self.balancer.clone();
        let provider_key = self.provider_key.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                balancer.compact_provider_state(&provider_key).await;
            });
        }
    }
}

impl ProviderLoadBalancer {
    pub async fn order_providers_for_session(
        &self,
        app_type: &str,
        session_id: &str,
        providers: &[Provider],
    ) -> Vec<Provider> {
        if providers.len() <= 1 {
            return providers.to_vec();
        };

        let mut inner = self.inner.write().await;
        prune_sticky_sessions(&mut inner);
        prune_session_failures(&mut inner);
        let failed_provider_ids = failed_provider_ids_locked(&inner, app_type, session_id);

        if let Some(sticky_provider_id) =
            sticky_provider_id_locked(&mut inner, app_type, session_id)
        {
            if !failed_provider_ids
                .iter()
                .any(|provider_id| provider_id == &sticky_provider_id)
            {
                if let Some(index) = providers
                    .iter()
                    .position(|provider| provider.id == sticky_provider_id)
                {
                    return reorder_with_provider_first(providers, index);
                }
            }
        }

        if !providers
            .iter()
            .any(|provider| provider_load_limits(provider).has_limits())
        {
            return move_failed_providers_to_end(providers, &failed_provider_ids);
        }

        let ordered = order_providers_by_load_locked(&mut inner, app_type, providers);
        move_failed_providers_to_end(&ordered, &failed_provider_ids)
    }

    pub async fn acquire(
        &self,
        app_type: &str,
        session_id: &str,
        provider: &Provider,
    ) -> Result<ProviderLoadPermit, ProviderLoadRejected> {
        let should_track_session = !session_id.trim().is_empty();
        if should_track_session
            && self
                .is_session_bound_to_provider(app_type, session_id, &provider.id)
                .await
        {
            let limits = provider_load_limits(provider);
            let key = provider_key(app_type, &provider.id);
            let mut inner = self.inner.write().await;
            return match check_and_reserve_rpm(&mut inner, &key, limits.rpm_limit()) {
                CapacityDecision::Available => {
                    let active_request_counter =
                        increment_active_request_locked(&mut inner, app_type, &provider.id);
                    Ok(ProviderLoadPermit {
                        provider_key: key,
                        active_request_counter: Some(active_request_counter),
                        active_unbound_request_counter: None,
                        semaphore_permit: None,
                        balancer: self.clone(),
                    })
                }
                CapacityDecision::RpmFull => {
                    log::debug!(
                        "[{app_type}] Provider {} 达到 RPM 上限，尝试下一家",
                        provider.id
                    );
                    Err(ProviderLoadRejected {
                        reason: ProviderLoadRejectReason::RpmFull,
                    })
                }
            };
        }

        let limits = provider_load_limits(provider);
        if !limits.has_limits() {
            let key = provider_key(app_type, &provider.id);
            let mut inner = self.inner.write().await;
            let active_request_counter =
                increment_active_request_locked(&mut inner, app_type, &provider.id);
            let active_unbound_request_counter =
                increment_active_unbound_request_locked(&mut inner, app_type, &provider.id);
            return Ok(ProviderLoadPermit {
                provider_key: key,
                active_request_counter: Some(active_request_counter),
                active_unbound_request_counter: Some(active_unbound_request_counter),
                semaphore_permit: None,
                balancer: self.clone(),
            });
        }

        let key = provider_key(app_type, &provider.id);
        let concurrency_limit = limits.max_concurrent_limit();
        let semaphore_permit = match concurrency_limit {
            Some(limit) => {
                let mut inner = self.inner.write().await;
                if current_concurrency_usage(&inner, app_type, &provider.id) >= limit {
                    log::debug!(
                        "[{app_type}] Provider {} 达到并发上限，尝试下一家",
                        provider.id
                    );
                    return Err(ProviderLoadRejected {
                        reason: ProviderLoadRejectReason::ConcurrencyFull,
                    });
                }

                let semaphore_key = semaphore_key(&key, limit);
                let semaphore = inner
                    .semaphores
                    .entry(semaphore_key)
                    .or_insert_with(|| Arc::new(Semaphore::new(limit)))
                    .clone();

                match semaphore.try_acquire_owned() {
                    Ok(permit) => Some(permit),
                    Err(_) => {
                        log::debug!(
                            "[{app_type}] Provider {} 达到并发上限，尝试下一家",
                            provider.id
                        );
                        return Err(ProviderLoadRejected {
                            reason: ProviderLoadRejectReason::ConcurrencyFull,
                        });
                    }
                }
            }
            None => None,
        };

        let mut inner = self.inner.write().await;
        match check_and_reserve_rpm(&mut inner, &key, limits.rpm_limit()) {
            CapacityDecision::Available => {
                let active_request_counter =
                    increment_active_request_locked(&mut inner, app_type, &provider.id);
                let active_unbound_request_counter =
                    increment_active_unbound_request_locked(&mut inner, app_type, &provider.id);
                Ok(ProviderLoadPermit {
                    provider_key: key,
                    active_request_counter: Some(active_request_counter),
                    active_unbound_request_counter: Some(active_unbound_request_counter),
                    semaphore_permit,
                    balancer: self.clone(),
                })
            }
            CapacityDecision::RpmFull => {
                log::debug!(
                    "[{app_type}] Provider {} 达到 RPM 上限，尝试下一家",
                    provider.id
                );
                Err(ProviderLoadRejected {
                    reason: ProviderLoadRejectReason::RpmFull,
                })
            }
        }
    }

    pub async fn bind_success(
        &self,
        app_type: &str,
        session_id: &str,
        provider_id: &str,
        load_permit: &mut ProviderLoadPermit,
    ) {
        if session_id.trim().is_empty() {
            return;
        }

        let session_slot = load_permit.semaphore_permit.take();
        if let Some(counter) = load_permit.active_unbound_request_counter.take() {
            decrement_active_request_counter(&counter);
        }
        let mut inner = self.inner.write().await;
        bind_session_locked(&mut inner, app_type, session_id, provider_id, session_slot);
    }

    pub async fn record_failure(&self, app_type: &str, session_id: &str, provider_id: &str) {
        if session_id.trim().is_empty() {
            return;
        }

        let mut inner = self.inner.write().await;
        prune_sticky_sessions(&mut inner);
        prune_session_failures(&mut inner);

        let key = sticky_key(app_type, session_id);
        if inner
            .sticky_sessions
            .get(&key)
            .is_some_and(|sticky| sticky.provider_id == provider_id)
        {
            inner.sticky_sessions.remove(&key);
        }

        inner
            .session_failures
            .entry(key)
            .or_default()
            .insert(provider_id.to_string(), Instant::now());
    }

    pub async fn is_session_bound_to_provider(
        &self,
        app_type: &str,
        session_id: &str,
        provider_id: &str,
    ) -> bool {
        self.sticky_provider_id(app_type, session_id)
            .await
            .is_some_and(|sticky_provider_id| sticky_provider_id == provider_id)
    }

    pub async fn active_session_targets(&self) -> Vec<ActiveSessionTarget> {
        let mut inner = self.inner.write().await;
        prune_sticky_sessions(&mut inner);
        prune_active_request_counters(&mut inner);
        prune_active_unbound_request_counters(&mut inner);

        let mut grouped: HashMap<(String, String), ActiveSessionTarget> = HashMap::new();
        for sticky in inner.sticky_sessions.values() {
            grouped
                .entry((sticky.app_type.clone(), sticky.provider_id.clone()))
                .or_insert_with(|| ActiveSessionTarget {
                    app_type: sticky.app_type.clone(),
                    provider_id: sticky.provider_id.clone(),
                    active_connections: 0,
                    session_ids: Vec::new(),
                })
                .session_ids
                .push(sticky.session_id.clone());
        }

        for ((app_type, provider_id), counter) in &inner.active_requests {
            let count = counter.load(Ordering::Acquire);
            if count == 0 {
                continue;
            }
            grouped
                .entry((app_type.clone(), provider_id.clone()))
                .or_insert_with(|| ActiveSessionTarget {
                    app_type: app_type.clone(),
                    provider_id: provider_id.clone(),
                    active_connections: 0,
                    session_ids: Vec::new(),
                })
                .active_connections = count;
        }

        let mut active_unbound_requests: HashMap<(String, String), usize> = HashMap::new();
        for ((app_type, provider_id), counter) in &inner.active_unbound_requests {
            let count = counter.load(Ordering::Acquire);
            if count == 0 {
                continue;
            }
            grouped
                .entry((app_type.clone(), provider_id.clone()))
                .or_insert_with(|| ActiveSessionTarget {
                    app_type: app_type.clone(),
                    provider_id: provider_id.clone(),
                    active_connections: 0,
                    session_ids: Vec::new(),
                });
            active_unbound_requests.insert((app_type.clone(), provider_id.clone()), count);
        }

        let mut targets: Vec<_> = grouped.into_values().collect();
        for target in &mut targets {
            target.session_ids.sort();
            let active_unbound_count = active_unbound_requests
                .get(&(target.app_type.clone(), target.provider_id.clone()))
                .copied()
                .unwrap_or(0);
            target.active_connections = active_connection_count_locked(
                &inner,
                &target.app_type,
                &target.provider_id,
                target.active_connections,
                active_unbound_count,
                target.session_ids.len(),
            );
        }
        targets.sort_by(|a, b| {
            a.app_type
                .cmp(&b.app_type)
                .then_with(|| a.provider_id.cmp(&b.provider_id))
        });
        targets
    }

    async fn sticky_provider_id(&self, app_type: &str, session_id: &str) -> Option<String> {
        let mut inner = self.inner.write().await;
        prune_sticky_sessions(&mut inner);
        sticky_provider_id_locked(&mut inner, app_type, session_id)
    }

    async fn compact_provider_state(&self, provider_key: &str) {
        let mut inner = self.inner.write().await;
        prune_active_request_counters(&mut inner);
        prune_active_unbound_request_counters(&mut inner);
        prune_rpm_window(&mut inner, provider_key);
        prune_sticky_sessions(&mut inner);
        prune_session_failures(&mut inner);
    }
}

fn provider_load_limits(provider: &Provider) -> ProviderLoadLimits {
    provider
        .meta
        .as_ref()
        .and_then(|meta| meta.load_limits.clone())
        .unwrap_or_default()
}

fn sticky_provider_id_locked(
    inner: &mut LoadState,
    app_type: &str,
    session_id: &str,
) -> Option<String> {
    if session_id.trim().is_empty() {
        return None;
    }

    let key = sticky_key(app_type, session_id);
    inner.sticky_sessions.get_mut(&key).map(|sticky| {
        sticky.last_seen = Instant::now();
        sticky.provider_id.clone()
    })
}

fn failed_provider_ids_locked(inner: &LoadState, app_type: &str, session_id: &str) -> Vec<String> {
    if session_id.trim().is_empty() {
        return Vec::new();
    }

    inner
        .session_failures
        .get(&sticky_key(app_type, session_id))
        .map(|failures| failures.keys().cloned().collect())
        .unwrap_or_default()
}

fn reorder_with_provider_first(providers: &[Provider], index: usize) -> Vec<Provider> {
    let mut ordered = Vec::with_capacity(providers.len());
    ordered.push(providers[index].clone());
    ordered.extend(
        providers
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != index)
            .map(|(_, provider)| provider.clone()),
    );
    ordered
}

fn move_failed_providers_to_end(
    providers: &[Provider],
    failed_provider_ids: &[String],
) -> Vec<Provider> {
    if failed_provider_ids.is_empty() {
        return providers.to_vec();
    }

    let mut available = Vec::with_capacity(providers.len());
    let mut failed = Vec::new();

    for provider in providers {
        if failed_provider_ids
            .iter()
            .any(|provider_id| provider_id == &provider.id)
        {
            failed.push(provider.clone());
        } else {
            available.push(provider.clone());
        }
    }

    if available.is_empty() {
        return providers.to_vec();
    }

    available.extend(failed);
    available
}

fn order_providers_by_load_locked(
    inner: &mut LoadState,
    app_type: &str,
    providers: &[Provider],
) -> Vec<Provider> {
    let len = providers.len();
    let cursor = inner
        .round_robin_cursors
        .entry(app_type.to_string())
        .or_default();
    let offset = *cursor % len;
    *cursor = cursor.wrapping_add(1);

    let mut scored: Vec<_> = providers
        .iter()
        .enumerate()
        .map(|(index, provider)| {
            let score = provider_load_score(inner, app_type, provider);
            let tie_order = (index + len - offset) % len;
            (score, tie_order, provider.clone())
        })
        .collect();

    scored.sort_by_key(|(score, tie_order, _)| (*score, *tie_order));
    scored
        .into_iter()
        .map(|(_, _, provider)| provider)
        .collect()
}

fn provider_load_score(inner: &mut LoadState, app_type: &str, provider: &Provider) -> u64 {
    let limits = provider_load_limits(provider);
    let concurrency_score = limits
        .max_concurrent_limit()
        .map(|limit| {
            ratio_score(
                current_concurrency_usage(inner, app_type, &provider.id),
                limit,
            )
        })
        .unwrap_or_else(|| {
            unconstrained_active_score(current_concurrency_usage(inner, app_type, &provider.id))
        });

    let rpm_score = limits.rpm_limit().map_or(0, |limit| {
        let key = provider_key(app_type, &provider.id);
        prune_rpm_window(inner, &key);
        let used = inner.rpm_windows.get(&key).map_or(0, VecDeque::len);
        ratio_score(used, limit)
    });

    concurrency_score.max(rpm_score)
}

fn active_session_count(inner: &LoadState, app_type: &str, provider_id: &str) -> usize {
    inner
        .sticky_sessions
        .values()
        .filter(|sticky| sticky.app_type == app_type && sticky.provider_id == provider_id)
        .count()
}

fn active_request_count(inner: &LoadState, app_type: &str, provider_id: &str) -> usize {
    inner
        .active_requests
        .get(&(app_type.to_string(), provider_id.to_string()))
        .map(|counter| counter.load(Ordering::Acquire))
        .unwrap_or(0)
}

fn active_unbound_request_count(inner: &LoadState, app_type: &str, provider_id: &str) -> usize {
    inner
        .active_unbound_requests
        .get(&(app_type.to_string(), provider_id.to_string()))
        .map(|counter| counter.load(Ordering::Acquire))
        .unwrap_or(0)
}

fn increment_active_request_locked(
    inner: &mut LoadState,
    app_type: &str,
    provider_id: &str,
) -> Arc<AtomicUsize> {
    let key = (app_type.to_string(), provider_id.to_string());
    let counter = inner
        .active_requests
        .entry(key)
        .or_insert_with(|| Arc::new(AtomicUsize::new(0)))
        .clone();
    counter.fetch_add(1, Ordering::AcqRel);
    counter
}

fn increment_active_unbound_request_locked(
    inner: &mut LoadState,
    app_type: &str,
    provider_id: &str,
) -> Arc<AtomicUsize> {
    let key = (app_type.to_string(), provider_id.to_string());
    let counter = inner
        .active_unbound_requests
        .entry(key)
        .or_insert_with(|| Arc::new(AtomicUsize::new(0)))
        .clone();
    counter.fetch_add(1, Ordering::AcqRel);
    counter
}

fn prune_active_request_counters(inner: &mut LoadState) {
    inner
        .active_requests
        .retain(|_, counter| counter.load(Ordering::Acquire) > 0);
}

fn prune_active_unbound_request_counters(inner: &mut LoadState) {
    inner
        .active_unbound_requests
        .retain(|_, counter| counter.load(Ordering::Acquire) > 0);
}

fn decrement_active_request_counter(counter: &AtomicUsize) {
    let _ = counter.fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
        Some(value.saturating_sub(1))
    });
}

fn current_concurrency_usage(inner: &LoadState, app_type: &str, provider_id: &str) -> usize {
    active_connection_count_locked(
        inner,
        app_type,
        provider_id,
        active_request_count(inner, app_type, provider_id),
        active_unbound_request_count(inner, app_type, provider_id),
        active_session_count(inner, app_type, provider_id),
    )
}

fn active_connection_count_locked(
    inner: &LoadState,
    app_type: &str,
    provider_id: &str,
    active_requests: usize,
    active_unbound_requests: usize,
    active_sessions: usize,
) -> usize {
    let active_sticky_requests = active_requests.saturating_sub(active_unbound_requests);
    let logical_usage = active_sessions
        .max(active_sticky_requests)
        .saturating_add(active_unbound_requests);

    semaphore_concurrency_usage(inner, app_type, provider_id).max(logical_usage)
}

fn semaphore_concurrency_usage(inner: &LoadState, app_type: &str, provider_id: &str) -> usize {
    let key_prefix = format!("{}:concurrency:", provider_key(app_type, provider_id));
    inner
        .semaphores
        .iter()
        .filter(|(key, _)| key.starts_with(&key_prefix))
        .map(|(key, semaphore)| {
            concurrency_limit_from_semaphore_key(key)
                .map(|limit| limit.saturating_sub(semaphore.available_permits()))
                .unwrap_or(0)
        })
        .sum()
}

fn concurrency_limit_from_semaphore_key(key: &str) -> Option<usize> {
    key.rsplit_once(":concurrency:")?.1.parse().ok()
}

fn ratio_score(used: usize, limit: usize) -> u64 {
    if limit == 0 {
        return 0;
    }
    (used as u64).saturating_mul(LOAD_SCORE_SCALE) / limit as u64
}

fn unconstrained_active_score(active_sessions: usize) -> u64 {
    if active_sessions == 0 {
        return 0;
    }
    (active_sessions as u64).saturating_mul(LOAD_SCORE_SCALE) / (active_sessions as u64 + 1)
}

fn check_and_reserve_rpm(
    inner: &mut LoadState,
    provider_key: &str,
    rpm_limit: Option<usize>,
) -> CapacityDecision {
    let Some(limit) = rpm_limit else {
        return CapacityDecision::Available;
    };

    let now = Instant::now();
    let window = inner
        .rpm_windows
        .entry(provider_key.to_string())
        .or_default();
    while window
        .front()
        .is_some_and(|timestamp| now.duration_since(*timestamp) >= RPM_WINDOW)
    {
        window.pop_front();
    }

    if window.len() >= limit {
        return CapacityDecision::RpmFull;
    }

    window.push_back(now);
    CapacityDecision::Available
}

fn prune_rpm_window(inner: &mut LoadState, provider_key: &str) {
    let Some(window) = inner.rpm_windows.get_mut(provider_key) else {
        return;
    };

    let now = Instant::now();
    while window
        .front()
        .is_some_and(|timestamp| now.duration_since(*timestamp) >= RPM_WINDOW)
    {
        window.pop_front();
    }

    if window.is_empty() {
        inner.rpm_windows.remove(provider_key);
    }
}

fn bind_session_locked(
    inner: &mut LoadState,
    app_type: &str,
    session_id: &str,
    provider_id: &str,
    session_slot: Option<OwnedSemaphorePermit>,
) {
    prune_sticky_sessions(inner);
    prune_session_failures(inner);
    let key = sticky_key(app_type, session_id);
    let now = Instant::now();
    inner.session_failures.remove(&key);

    if let Some(sticky) = inner.sticky_sessions.get_mut(&key) {
        if sticky.provider_id == provider_id && session_slot.is_none() {
            sticky.last_seen = now;
            let _ = sticky.session_slot.is_some();
            return;
        }
    }

    inner.sticky_sessions.insert(
        key,
        StickyProvider {
            app_type: app_type.to_string(),
            session_id: session_id.to_string(),
            provider_id: provider_id.to_string(),
            last_seen: now,
            session_slot,
        },
    );
}

fn prune_sticky_sessions(inner: &mut LoadState) {
    let now = Instant::now();
    inner
        .sticky_sessions
        .retain(|_, sticky| now.duration_since(sticky.last_seen) < Duration::from_secs(60 * 60));
}

fn prune_session_failures(inner: &mut LoadState) {
    let now = Instant::now();
    inner.session_failures.retain(|_, failures| {
        failures.retain(|_, failed_at| now.duration_since(*failed_at) < SESSION_FAILURE_COOLDOWN);
        !failures.is_empty()
    });
}

fn sticky_key(app_type: &str, session_id: &str) -> String {
    format!("{app_type}:{session_id}")
}

fn provider_key(app_type: &str, provider_id: &str) -> String {
    format!("{app_type}:{provider_id}")
}

fn semaphore_key(provider_key: &str, limit: usize) -> String {
    format!("{provider_key}:concurrency:{limit}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::ProviderMeta;
    use serde_json::json;

    fn provider(id: &str, max_concurrent: Option<u32>, rpm: Option<u32>) -> Provider {
        Provider {
            id: id.to_string(),
            name: id.to_string(),
            settings_config: json!({}),
            website_url: None,
            category: None,
            created_at: None,
            sort_index: None,
            notes: None,
            meta: Some(ProviderMeta {
                load_limits: Some(ProviderLoadLimits {
                    max_concurrent,
                    rpm,
                }),
                ..ProviderMeta::default()
            }),
            icon: None,
            icon_color: None,
            in_failover_queue: true,
        }
    }

    #[tokio::test]
    async fn acquire_respects_concurrency_limit() {
        let balancer = ProviderLoadBalancer::default();
        let p = provider("p1", Some(1), None);

        let mut first = balancer.acquire("claude", "s1", &p).await.unwrap();
        balancer
            .bind_success("claude", "s1", &p.id, &mut first)
            .await;

        assert_eq!(
            balancer
                .acquire("claude", "s2", &p)
                .await
                .err()
                .unwrap()
                .reason,
            ProviderLoadRejectReason::ConcurrencyFull
        );
        assert!(balancer.acquire("claude", "s1", &p).await.is_ok());

        drop(first);
        assert_eq!(
            balancer
                .acquire("claude", "s2", &p)
                .await
                .err()
                .unwrap()
                .reason,
            ProviderLoadRejectReason::ConcurrencyFull
        );
    }

    #[tokio::test]
    async fn acquire_respects_concurrency_limit_without_session_id() {
        let balancer = ProviderLoadBalancer::default();
        let p = provider("p1", Some(1), None);

        let first = balancer.acquire("claude", "", &p).await.unwrap();

        assert_eq!(
            balancer
                .acquire("claude", "", &p)
                .await
                .err()
                .unwrap()
                .reason,
            ProviderLoadRejectReason::ConcurrencyFull
        );

        drop(first);
        assert!(balancer.acquire("claude", "", &p).await.is_ok());
    }

    #[tokio::test]
    async fn acquire_respects_lowered_concurrency_limit() {
        let balancer = ProviderLoadBalancer::default();
        let p_limit_two = provider("p1", Some(2), None);
        let p_limit_one = provider("p1", Some(1), None);

        let mut first = balancer
            .acquire("claude", "s1", &p_limit_two)
            .await
            .unwrap();
        balancer
            .bind_success("claude", "s1", &p_limit_two.id, &mut first)
            .await;

        assert_eq!(
            balancer
                .acquire("claude", "s2", &p_limit_one)
                .await
                .err()
                .unwrap()
                .reason,
            ProviderLoadRejectReason::ConcurrencyFull
        );
    }

    #[tokio::test]
    async fn acquire_respects_rpm_limit() {
        let balancer = ProviderLoadBalancer::default();
        let p = provider("p1", None, Some(1));

        assert!(balancer.acquire("claude", "s1", &p).await.is_ok());
        assert_eq!(
            balancer
                .acquire("claude", "s2", &p)
                .await
                .err()
                .unwrap()
                .reason,
            ProviderLoadRejectReason::RpmFull
        );
    }

    #[tokio::test]
    async fn sticky_session_respects_rpm_limit() {
        let balancer = ProviderLoadBalancer::default();
        let p = provider("p1", None, Some(1));

        let mut first = balancer.acquire("claude", "s1", &p).await.unwrap();
        balancer
            .bind_success("claude", "s1", &p.id, &mut first)
            .await;
        drop(first);

        assert_eq!(
            balancer
                .acquire("claude", "s1", &p)
                .await
                .err()
                .unwrap()
                .reason,
            ProviderLoadRejectReason::RpmFull
        );
    }

    #[tokio::test]
    async fn sticky_provider_is_first_when_available() {
        let balancer = ProviderLoadBalancer::default();
        let p1 = provider("p1", None, None);
        let p2 = provider("p2", None, None);

        let mut permit = balancer.acquire("claude", "session", &p2).await.unwrap();
        balancer
            .bind_success("claude", "session", &p2.id, &mut permit)
            .await;
        let ordered = balancer
            .order_providers_for_session("claude", "session", &[p1.clone(), p2.clone()])
            .await;

        assert_eq!(ordered[0].id, "p2");
        assert_eq!(ordered[1].id, "p1");
        assert!(
            balancer
                .is_session_bound_to_provider("claude", "session", &p2.id)
                .await
        );
        assert!(
            !balancer
                .is_session_bound_to_provider("claude", "session", &p1.id)
                .await
        );
    }

    #[tokio::test]
    async fn failed_sticky_session_uses_next_provider_on_next_request() {
        let balancer = ProviderLoadBalancer::default();
        let p1 = provider("p1", None, None);
        let p2 = provider("p2", None, None);

        let mut permit = balancer.acquire("claude", "session", &p1).await.unwrap();
        balancer
            .bind_success("claude", "session", &p1.id, &mut permit)
            .await;

        balancer.record_failure("claude", "session", &p1.id).await;

        let ordered = balancer
            .order_providers_for_session("claude", "session", &[p1.clone(), p2.clone()])
            .await;

        assert_eq!(ordered[0].id, "p2");
        assert_eq!(ordered[1].id, "p1");
        assert!(
            !balancer
                .is_session_bound_to_provider("claude", "session", &p1.id)
                .await
        );
    }

    #[tokio::test]
    async fn successful_rebind_clears_session_failure_avoidance() {
        let balancer = ProviderLoadBalancer::default();
        let p1 = provider("p1", None, None);
        let p2 = provider("p2", None, None);

        balancer.record_failure("claude", "session", &p1.id).await;
        let mut permit = balancer.acquire("claude", "session", &p1).await.unwrap();
        balancer
            .bind_success("claude", "session", &p1.id, &mut permit)
            .await;

        let ordered = balancer
            .order_providers_for_session("claude", "session", &[p1.clone(), p2.clone()])
            .await;

        assert_eq!(ordered[0].id, "p1");
        assert_eq!(ordered[1].id, "p2");
    }

    #[tokio::test]
    async fn new_session_prefers_less_loaded_provider_when_limits_exist() {
        let balancer = ProviderLoadBalancer::default();
        let p1 = provider("p1", Some(2), None);
        let p2 = provider("p2", Some(2), None);

        let mut permit = balancer.acquire("claude", "s1", &p1).await.unwrap();
        balancer
            .bind_success("claude", "s1", &p1.id, &mut permit)
            .await;

        let ordered = balancer
            .order_providers_for_session("claude", "s2", &[p1.clone(), p2.clone()])
            .await;

        assert_eq!(ordered[0].id, "p2");
        assert_eq!(ordered[1].id, "p1");
    }

    #[tokio::test]
    async fn new_session_accounts_for_unbound_requests_without_concurrency_limit() {
        let balancer = ProviderLoadBalancer::default();
        let p1 = provider("p1", None, None);
        let p2 = provider("p2", None, Some(60));

        let unbound = balancer.acquire("claude", "", &p1).await.unwrap();

        let ordered = balancer
            .order_providers_for_session("claude", "s2", &[p1.clone(), p2.clone()])
            .await;

        assert_eq!(ordered[0].id, "p2");
        assert_eq!(ordered[1].id, "p1");

        drop(unbound);
    }

    #[tokio::test]
    async fn new_session_order_rotates_when_limited_providers_have_equal_load() {
        let balancer = ProviderLoadBalancer::default();
        let p1 = provider("p1", Some(2), None);
        let p2 = provider("p2", Some(2), None);

        let first = balancer
            .order_providers_for_session("claude", "s1", &[p1.clone(), p2.clone()])
            .await;
        let second = balancer
            .order_providers_for_session("claude", "s2", &[p1.clone(), p2.clone()])
            .await;

        assert_eq!(first[0].id, "p1");
        assert_eq!(second[0].id, "p2");
    }

    #[tokio::test]
    async fn new_session_keeps_queue_order_without_load_limits() {
        let balancer = ProviderLoadBalancer::default();
        let p1 = provider("p1", None, None);
        let p2 = provider("p2", None, None);

        let mut permit = balancer.acquire("claude", "s1", &p1).await.unwrap();
        balancer
            .bind_success("claude", "s1", &p1.id, &mut permit)
            .await;

        let ordered = balancer
            .order_providers_for_session("claude", "s2", &[p1.clone(), p2.clone()])
            .await;

        assert_eq!(ordered[0].id, "p1");
        assert_eq!(ordered[1].id, "p2");
    }

    #[tokio::test]
    async fn active_session_targets_group_by_app_and_provider() {
        let balancer = ProviderLoadBalancer::default();
        let p1 = provider("p1", None, None);
        let p2 = provider("p2", None, None);

        let mut permit = balancer.acquire("claude", "s2", &p2).await.unwrap();
        balancer
            .bind_success("claude", "s2", &p2.id, &mut permit)
            .await;
        let mut permit = balancer.acquire("claude", "s1", &p2).await.unwrap();
        balancer
            .bind_success("claude", "s1", &p2.id, &mut permit)
            .await;
        let mut permit = balancer.acquire("codex", "thread-1", &p1).await.unwrap();
        balancer
            .bind_success("codex", "thread-1", &p1.id, &mut permit)
            .await;

        assert_eq!(
            balancer.active_session_targets().await,
            vec![
                ActiveSessionTarget {
                    app_type: "claude".to_string(),
                    provider_id: "p2".to_string(),
                    active_connections: 2,
                    session_ids: vec!["s1".to_string(), "s2".to_string()],
                },
                ActiveSessionTarget {
                    app_type: "codex".to_string(),
                    provider_id: "p1".to_string(),
                    active_connections: 1,
                    session_ids: vec!["thread-1".to_string()],
                },
            ]
        );
    }

    #[tokio::test]
    async fn active_session_targets_include_unbound_active_requests() {
        let balancer = ProviderLoadBalancer::default();
        let p1 = provider("p1", Some(2), None);

        let permit = balancer.acquire("claude", "", &p1).await.unwrap();

        assert_eq!(
            balancer.active_session_targets().await,
            vec![ActiveSessionTarget {
                app_type: "claude".to_string(),
                provider_id: "p1".to_string(),
                active_connections: 1,
                session_ids: Vec::new(),
            }]
        );

        drop(permit);
        assert!(balancer.active_session_targets().await.is_empty());
    }

    #[tokio::test]
    async fn active_session_targets_count_sticky_slots_and_unbound_requests() {
        let balancer = ProviderLoadBalancer::default();
        let p1 = provider("p1", Some(3), None);

        let mut sticky = balancer.acquire("claude", "s1", &p1).await.unwrap();
        balancer
            .bind_success("claude", "s1", &p1.id, &mut sticky)
            .await;
        drop(sticky);

        let unbound = balancer.acquire("claude", "", &p1).await.unwrap();

        assert_eq!(
            balancer.active_session_targets().await,
            vec![ActiveSessionTarget {
                app_type: "claude".to_string(),
                provider_id: "p1".to_string(),
                active_connections: 2,
                session_ids: vec!["s1".to_string()],
            }]
        );

        drop(unbound);
    }

    #[tokio::test]
    async fn active_session_targets_do_not_double_count_newly_bound_request() {
        let balancer = ProviderLoadBalancer::default();
        let p1 = provider("p1", None, None);

        let mut request = balancer.acquire("claude", "s1", &p1).await.unwrap();
        balancer
            .bind_success("claude", "s1", &p1.id, &mut request)
            .await;

        assert_eq!(
            balancer.active_session_targets().await,
            vec![ActiveSessionTarget {
                app_type: "claude".to_string(),
                provider_id: "p1".to_string(),
                active_connections: 1,
                session_ids: vec!["s1".to_string()],
            }]
        );

        drop(request);
    }

    #[tokio::test]
    async fn active_session_targets_count_sticky_slots_and_unbound_requests_without_limit() {
        let balancer = ProviderLoadBalancer::default();
        let p1 = provider("p1", None, None);

        let mut sticky = balancer.acquire("claude", "s1", &p1).await.unwrap();
        balancer
            .bind_success("claude", "s1", &p1.id, &mut sticky)
            .await;
        drop(sticky);

        let unbound = balancer.acquire("claude", "", &p1).await.unwrap();

        assert_eq!(
            balancer.active_session_targets().await,
            vec![ActiveSessionTarget {
                app_type: "claude".to_string(),
                provider_id: "p1".to_string(),
                active_connections: 2,
                session_ids: vec!["s1".to_string()],
            }]
        );

        drop(unbound);
    }
}
