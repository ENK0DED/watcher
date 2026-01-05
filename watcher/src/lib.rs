#![deny(clippy::all)]

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use globset::{Glob, GlobSet, GlobSetBuilder};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use notify::event::{CreateKind, ModifyKind, RemoveKind};
use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult};

/// Event type representing what kind of change occurred
#[napi(string_enum)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventType {
  #[napi(value = "create")]
  Create,
  #[napi(value = "update")]
  Update,
  #[napi(value = "delete")]
  Delete,
}

/// A file system event
#[napi(object)]
#[derive(Debug, Clone)]
pub struct WatchEvent {
  pub path: String,
  #[napi(js_name = "type")]
  pub event_type: EventType,
}

/// Options for configuring the watcher
#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct WatchOptions {
  /// Patterns to ignore (file paths or glob patterns)
  pub ignore: Option<Vec<String>>,
}

/// Callback result type for the watcher
#[napi(object)]
#[derive(Debug, Clone)]
pub struct WatchCallbackResult {
  pub error: Option<String>,
  pub events: Vec<WatchEvent>,
}

/// An active subscription that can be unsubscribed
#[napi]
pub struct Subscription {
  running: Arc<AtomicBool>,
  #[allow(dead_code)]
  watcher: Option<notify_debouncer_full::Debouncer<RecommendedWatcher, notify_debouncer_full::RecommendedCache>>,
}

#[napi]
impl Subscription {
  /// Stop watching for file system changes
  #[napi]
  pub fn unsubscribe(&mut self) -> Result<()> {
    self.running.store(false, Ordering::SeqCst);
    // Drop the watcher to stop receiving events
    self.watcher.take();
    Ok(())
  }
}

/// Build a GlobSet from ignore patterns
fn build_glob_set(patterns: &[String]) -> Result<GlobSet> {
  let mut builder = GlobSetBuilder::new();

  for pattern in patterns {
    let glob = Glob::new(pattern).map_err(|e| Error::new(Status::InvalidArg, format!("Invalid glob pattern '{}': {}", pattern, e)))?;
    builder.add(glob);
  }

  builder.build().map_err(|e| Error::new(Status::GenericFailure, format!("Failed to build glob set: {}", e)))
}

/// Check if a path should be ignored
fn should_ignore(path: &PathBuf, glob_set: &GlobSet, base_path: &PathBuf) -> bool {
  // Try matching against relative path first
  if let Ok(relative) = path.strip_prefix(base_path) && glob_set.is_match(relative) {
    return true;
  }

  // Also try matching against full path
  glob_set.is_match(path)
}

/// Convert notify event kind to our event type
fn event_kind_to_type(kind: &EventKind) -> Option<EventType> {
  match kind {
    EventKind::Create(CreateKind::File | CreateKind::Folder | CreateKind::Any) => Some(EventType::Create),
    EventKind::Modify(ModifyKind::Data(_) | ModifyKind::Name(_) | ModifyKind::Any | ModifyKind::Metadata(_)) => Some(EventType::Update),
    EventKind::Remove(RemoveKind::File | RemoveKind::Folder | RemoveKind::Any) => Some(EventType::Delete),
    _ => None,
  }
}

/// Subscribe to file system changes in a directory
///
/// # Arguments
/// * `directory` - The directory path to watch
/// * `callback` - Function called with (error, events) when changes occur
/// * `options` - Optional configuration including ignore patterns
///
/// # Returns
/// A subscription that can be used to stop watching
#[napi(ts_args_type = "directory: string, callback: (result: WatchCallbackResult) => void, options?: WatchOptions")]
pub fn subscribe(
  directory: String,
  callback: Function<WatchCallbackResult, ()>,
  options: Option<WatchOptions>,
) -> Result<Subscription> {
  let path = PathBuf::from(&directory);

  if !path.exists() {
    return Err(Error::new(Status::InvalidArg, format!("Directory does not exist: {}", directory)));
  }

  if !path.is_dir() {
    return Err(Error::new(Status::InvalidArg, format!("Path is not a directory: {}", directory)));
  }

  let base_path = path.canonicalize().map_err(|e| Error::new(Status::GenericFailure, format!("Failed to canonicalize path: {}", e)))?;

  // Build glob set for ignore patterns
  let ignore_patterns = options
    .as_ref()
    .and_then(|o| o.ignore.as_ref())
    .cloned()
    .unwrap_or_default();
  let glob_set = Arc::new(build_glob_set(&ignore_patterns)?);

  // Create threadsafe function for calling back to JS
  let tsfn = callback.build_threadsafe_function().build()?;
  let running = Arc::new(AtomicBool::new(true));
  let running_clone = Arc::clone(&running);
  let base_path_clone = base_path.clone();

  // Create debounced watcher with 100ms debounce time
  let mut debouncer = new_debouncer(
    Duration::from_millis(100),
    None,
    move |result: DebounceEventResult| {
      if !running_clone.load(Ordering::SeqCst) {
        return;
      }

      match result {
        Ok(debounced_events) => {
          let mut events = Vec::new();

          for debounced_event in debounced_events {
            let event = debounced_event.event;

            if let Some(event_type) = event_kind_to_type(&event.kind) {
              for path in &event.paths {
                if !should_ignore(path, &glob_set, &base_path_clone) {
                  events.push(WatchEvent { path: path.to_string_lossy().to_string(), event_type: event_type.clone() });
                }
              }
            }
          }

          if !events.is_empty() {
            tsfn.call(WatchCallbackResult { error: None, events }, napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking);
          }
        }
        Err(errors) => {
          let error_msg = errors
            .iter()
            .map(|e| e.to_string())
            .collect::<Vec<_>>()
            .join("; ");
          tsfn.call(WatchCallbackResult { error: Some(error_msg), events: vec![] }, napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking);
        }
      }
    },
  )
  .map_err(|e| Error::new(Status::GenericFailure, format!("Failed to create watcher: {}", e)))?;

  // Configure watcher for high performance
  let _config = Config::default()
    .with_poll_interval(Duration::from_millis(100))
    .with_compare_contents(false);

  // Start watching the directory
  debouncer
    .watch(&base_path, RecursiveMode::Recursive)
    .map_err(|e| Error::new(Status::GenericFailure, format!("Failed to watch directory: {}", e)))?;

  Ok(Subscription { running, watcher: Some(debouncer) })
}
