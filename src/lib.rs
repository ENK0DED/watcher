#![deny(clippy::all)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use globset::{Glob, GlobSet, GlobSetBuilder};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi::{Env, ValueType};
use napi_derive::napi;
use notify::event::{ModifyKind, RenameMode};
use notify::{EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{DebounceEventResult, Debouncer, NoCache, new_debouncer_opt};

/// A file system event
#[napi(object)]
#[derive(Debug, Clone)]
pub struct WatchEvent {
  pub path: String,
  #[napi(js_name = "type", ts_type = "'create' | 'update' | 'delete'")]
  pub event_type: String,
}

/// Options for configuring the watcher
#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct WatchOptions {
  /// Patterns to ignore (file paths or glob patterns). Ignoring a directory also ignores everything inside it.
  pub ignore: Option<Vec<String>>,
}

/// Callback result type for the watcher
#[napi(object, object_from_js = false)]
#[derive(Debug)]
pub struct WatchCallbackResult {
  pub error: Option<Error>,
  pub events: Vec<WatchEvent>,
}

/// An active subscription that can be unsubscribed
#[napi]
pub struct Subscription {
  id: u64,
  running: Arc<AtomicBool>,
}

#[napi]
impl Subscription {
  /// Stop watching for file system changes
  #[napi]
  pub fn unsubscribe(&mut self, env: Env) -> Result<()> {
    self.running.store(false, Ordering::SeqCst);
    // Drop the debouncer to stop receiving events
    Watchers::of(&env)?.active.remove(&self.id);
    Ok(())
  }
}

/// Running watchers by subscription ID, held as per-environment instance data. A watcher keeps running if its subscription
/// is garbage collected without being unsubscribed, and all of them stop when the environment shuts down.
#[derive(Default)]
struct Watchers {
  next_id: u64,
  active: HashMap<u64, Debouncer<RecommendedWatcher, NoCache>>,
}

impl Watchers {
  /// Get the watchers for an environment, creating them on first use
  fn of(env: &Env) -> Result<&'static mut Self> {
    if let Some(watchers) = env.get_instance_data::<Self>()? {
      return Ok(watchers);
    }

    env.set_instance_data(Self::default(), (), |_| {})?;
    env.get_instance_data::<Self>()?.ok_or_else(|| Error::new(Status::GenericFailure, "Failed to store watchers"))
  }
}

/// Throw a JS `TypeError` and return the error that tells napi-rs an exception is already pending
fn throw_type_error(env: &Env, message: &str) -> Error {
  match env.throw_type_error(message, Some(Status::InvalidArg.as_ref())) {
    Ok(()) => Error::new(Status::PendingException, ""),
    Err(error) => error,
  }
}

/// Convert a JS argument, throwing a `TypeError` with `message` if it isn't of the `expected` type
fn convert_arg<T: FromNapiValue>(env: &Env, value: &Unknown, expected: ValueType, message: &str) -> Result<T> {
  if value.get_type()? != expected {
    return Err(throw_type_error(env, message));
  }

  // SAFETY: `value` is an argument of the current call, so its env and handle are valid. With the type checked, this can
  // only fail for an object with a property of the wrong type, and the error names that property.
  unsafe { value.cast() }.map_err(|e| throw_type_error(env, &e.reason))
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
fn should_ignore(path: &Path, glob_set: &GlobSet, base_path: &Path) -> bool {
  if glob_set.is_empty() {
    return false;
  }

  let Ok(relative) = path.strip_prefix(base_path) else {
    return glob_set.is_match(path);
  };

  // Match the path and each of its parent directories below the base path, both relative and absolute,
  // so that ignoring a directory also ignores everything inside it
  path
    .ancestors()
    .zip(relative.ancestors())
    .take_while(|(_, relative)| !relative.as_os_str().is_empty())
    .any(|(full, relative)| glob_set.is_match(relative) || glob_set.is_match(full))
}

/// Convert a notify event kind to our event type for the path at `path_index`
fn event_kind_to_type(kind: &EventKind, path_index: usize) -> Option<&'static str> {
  match kind {
    EventKind::Create(_) | EventKind::Modify(ModifyKind::Name(RenameMode::To)) => Some("create"),
    EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(RenameMode::From)) => Some("delete"),
    // The debouncer joins both halves of a rename into one event with paths `[from, to]`
    EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => Some(if path_index == 0 { "delete" } else { "create" }),
    EventKind::Modify(_) => Some("update"),
    EventKind::Access(_) | EventKind::Any | EventKind::Other => None,
  }
}

/// Subscribe to file system changes in a directory
///
/// # Arguments
/// * `directory` - The directory path to watch
/// * `callback` - Function called with `{ error, events }` when changes occur
/// * `options` - Optional configuration including ignore patterns
///
/// # Returns
/// A subscription that keeps watching until `unsubscribe()` is called
#[napi(ts_args_type = "directory: string, callback: (result: WatchCallbackResult) => void, options?: WatchOptions")]
pub fn subscribe(env: Env, directory: Unknown, callback: Unknown, options: Option<Unknown>) -> Result<Subscription> {
  // Arguments of the wrong type throw a `TypeError`, invalid values a plain `Error`
  let directory: String = convert_arg(&env, &directory, ValueType::String, "Directory path must be a string")?;
  let callback: Function<WatchCallbackResult, ()> = convert_arg(&env, &callback, ValueType::Function, "Callback must be a function")?;
  let options: Option<WatchOptions> = options.map(|options| convert_arg(&env, &options, ValueType::Object, "Options must be an object")).transpose()?;

  if directory.is_empty() {
    return Err(Error::new(Status::InvalidArg, "Directory path cannot be empty"));
  }

  let path = PathBuf::from(&directory);

  if !path.exists() {
    return Err(Error::new(Status::InvalidArg, format!("Directory does not exist: {}", directory)));
  }

  if !path.is_dir() {
    return Err(Error::new(Status::InvalidArg, format!("Path is not a directory: {}", directory)));
  }

  let base_path = dunce::canonicalize(&path).map_err(|e| Error::new(Status::GenericFailure, format!("Failed to canonicalize path: {}", e)))?;

  // Build glob set for ignore patterns
  let glob_set = build_glob_set(options.and_then(|o| o.ignore).as_deref().unwrap_or_default())?;

  // Create threadsafe function for calling back to JS
  let tsfn = callback.build_threadsafe_function().build()?;
  let running = Arc::new(AtomicBool::new(true));
  let running_clone = Arc::clone(&running);
  let base_path_clone = base_path.clone();

  // Convert debounced events and pass them to the callback
  let event_handler = move |result: DebounceEventResult| {
    if !running_clone.load(Ordering::SeqCst) {
      return;
    }

    match result {
      Ok(debounced_events) => {
        let mut events = Vec::new();

        for debounced_event in debounced_events {
          let event = debounced_event.event;

          for (path_index, path) in event.paths.iter().enumerate() {
            if let Some(event_type) = event_kind_to_type(&event.kind, path_index)
              && !should_ignore(path, &glob_set, &base_path_clone)
            {
              // Strip the Windows extended-length path prefix where that's safe
              events.push(WatchEvent { path: dunce::simplified(path).to_string_lossy().into_owned(), event_type: event_type.to_string() });
            }
          }
        }

        if !events.is_empty() {
          tsfn.call(WatchCallbackResult { error: None, events }, ThreadsafeFunctionCallMode::NonBlocking);
        }
      }
      Err(errors) => {
        let error_msg = errors.iter().map(|e| e.to_string()).collect::<Vec<_>>().join("; ");
        tsfn.call(WatchCallbackResult { error: Some(Error::new(Status::GenericFailure, error_msg)), events: vec![] }, ThreadsafeFunctionCallMode::NonBlocking);
      }
    }
  };

  // Create debounced watcher with 100ms debounce time. The file ID cache is skipped: it only stitches the two halves of a
  // rename together, which we report as a delete and a create either way, and filling it scans the whole tree on macOS and Windows
  let mut debouncer = new_debouncer_opt::<_, RecommendedWatcher, _>(Duration::from_millis(100), None, event_handler, NoCache, notify::Config::default())
    .map_err(|e| Error::new(Status::GenericFailure, format!("Failed to create watcher: {}", e)))?;

  // Start watching the directory
  debouncer.watch(&base_path, RecursiveMode::Recursive).map_err(|e| Error::new(Status::GenericFailure, format!("Failed to watch directory: {}", e)))?;

  let watchers = Watchers::of(&env)?;
  let id = watchers.next_id;
  watchers.next_id += 1;
  watchers.active.insert(id, debouncer);

  Ok(Subscription { id, running })
}
