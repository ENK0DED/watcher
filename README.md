# @enk0ded/watcher

[![CI](https://github.com/ENK0DED/watcher/actions/workflows/CI.yml/badge.svg)](https://github.com/ENK0DED/watcher/actions/workflows/CI.yml)

> A high-performance file system watcher for Node.js, written in Rust and exposed via N-API bindings.

## Features

- **High Performance**: Uses native OS APIs (inotify on Linux, FSEvents on macOS, ReadDirectoryChangesW on Windows)
- **Cross-Platform**: Works on Linux, macOS, and Windows
- **Event Debouncing**: Built-in debouncing to coalesce rapid file system changes
- **Glob Pattern Support**: Flexible ignore patterns using glob syntax
- **Recursive Watching**: Automatically watches all subdirectories
- **TypeScript First**: Full TypeScript support with comprehensive type definitions

## Installation

```bash
bun add @enk0ded/watcher
```

## Usage

```typescript
import { subscribe } from '@enk0ded/watcher';

// Start watching a directory
const subscription = subscribe(
  '/path/to/watch',
  ({ error, events }) => {
    if (error) {
      console.error('Watch error:', error);
      return;
    }

    for (const event of events) {
      console.log(`${event.type}: ${event.path}`);
    }
  },
  { ignore: ['node_modules', '*.log', '.git/**'] },
);

// Later, stop watching
subscription.unsubscribe();
```

## API

### `subscribe(directory, callback, options?)`

Subscribes to file system changes in a directory.

#### Parameters

- `directory` (`string`): The directory path to watch (must exist and be a directory)
- `callback` (`({ error, events }: { error?: Error; events: Event[] }) => void`): Function called when changes occur
- `options` (`Options`, optional): Configuration options
  - `ignore` (`string[]`, optional): Patterns to ignore (file paths or glob patterns)

#### Returns

`Promise<Subscription>`: A subscription object with an `unsubscribe()` method.

### Event Types

```typescript
type WatchEvent = {
  path: string; // Absolute path to the changed file/directory
  type: 'create' | 'update' | 'delete'; // Type of change
};
```

## Development

### Prerequisites

- [Bun](https://bun.sh) >= 1.3.5
- [Rust](https://rustup.rs) >= 1.92.0
- Node.js >= 24

### Building

After `bun run build` command, you can see a `watcher.[darwin|win32|linux].node` file in project root. This is the native addon built from [lib.rs](./src/lib.rs).

```bash
# Install dependencies
bun install

# Build
bun run build

# Build in debug mode
bun dev
```

### Testing

This package uses Bun's built in [Test runner](https://bun.com/docs/test).

```bash
bun test
```

### CI

With GitHub Actions, each commit and pull request will be built and tested automatically in [`node@24`] x [`macOS`, `Linux`, `Windows`] matrix.

### Release

The release action of this package releases multiple NPM packages for different platforms and adds them to `optionalDependencies` before releasing the main package.

Your package manager will choose which native package it should install automatically. You can take a look at the [npm](./npm) directory for details.

## Performance

This watcher is optimized for performance:

- Uses OS-native file watching APIs
- Events are debounced (100ms default) to reduce callback overhead
- Glob patterns are pre-compiled at subscription time
- Zero-copy event handling in Rust
- Efficient thread communication via crossbeam channels

## Release package

Ensure you have set your **NPM_TOKEN** in the `GitHub` project setting.

In `Settings -> Secrets`, add **NPM_TOKEN** into it.

When you want to release the package:

```bash
npm version [<newversion> | major | minor | patch | premajor | preminor | prepatch | prerelease [--preid=<prerelease-id>] | from-git]

git push
```

GitHub actions will do the rest job for you.

> WARN: Don't run `npm publish` manually.
